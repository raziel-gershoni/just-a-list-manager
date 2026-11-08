"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ItemData, ListCategory } from "@/src/types";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";
import { shouldRespawn } from "@/src/utils/recurring-respawn";
import { sortCategories, clearItemCategories } from "@/src/utils/category-state";
import { throwIfNotOk } from "@/src/utils/http";
import { genMutId } from "@/src/utils/list-helpers";
import { getSyncEngine } from "@/src/sync/engine";
import { mergeRefresh } from "@/src/sync/merge";

// The list cap is 500 non-deleted items (insert_item_if_under_limit uses the same
// predicate as GET /items), so limit=500 covers every normal case. It is a cap, not a
// guarantee: the voice insert (src/services/voice-handler.ts) and the PATCH
// undo-restore (app/api/lists/[id]/items/route.ts) bypass the cap RPC, so a list can
// exceed 500 and GET then drops the lowest positions. The route defaults to 200 and we
// ignore nextCursor, which would silently truncate.
const ITEMS_FETCH_LIMIT = 500;
const ITEMS_URL_SUFFIX = `?limit=${ITEMS_FETCH_LIMIT}`;

export function useListData(listId: string, jwtRef: React.RefObject<string | null>) {
  const [listName, setListName] = useState("");
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The list is gone for this user (deleted, or access removed): a 403/404 that Retry can't fix.
  const [notFound, setNotFound] = useState(false);
  // The same, readable at once: a caller that awaited a failed load can tell a gone list
  // (nothing to retry) from one that may still load, before the state reaches a render.
  const unavailableRef = useRef(false);
  const [isShared, setIsShared] = useState(false);
  const [listType, setListType] = useState<ListType>("regular");
  const [listIcon, setListIcon] = useState<ListIconName | null>(null);
  const [listColor, setListColor] = useState<ListColor | null>(null);
  const [categories, setCategories] = useState<ListCategory[]>([]);
  // The grocery categories switch. An old server sends no field: that list is sorted, as before.
  const [categoriesEnabled, setCategoriesEnabled] = useState(true);
  // The same, readable at once by a read whose answer comes back before the next render.
  const categoriesEnabledRef = useRef(true);
  // The rows on screen as of the last render: a refresh compares them with the rows on screen
  // when its answer comes back, to tell what changed while the GET was out.
  const itemsRef = useRef<ItemData[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // The list works without categories (items show under "Sorting…"), so a failed request
  // (an error status or no answer at all) is only logged: it must never turn into the
  // list's error screen.
  // applyCategoriesSwitch bumps switchGenRef: an answer that left before an off holds categories
  // the server has since deleted, so it writes nothing.
  const switchGenRef = useRef(0);
  const loadCategories = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const gen = switchGenRef.current;
    try {
      const res = await fetch(`/api/lists/${listId}/categories`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const { categories: fetched } = await res.json();
        if (gen !== switchGenRef.current) {
          console.warn("[List] Categories answer dropped: categories were turned off meanwhile", { listId });
          return;
        }
        setCategories(sortCategories(fetched ?? []));
      } else {
        console.warn("[List] Categories load failed:", { listId, status: res.status });
      }
    } catch (e) {
      console.error("[List] Categories fetch error:", e);
    }
  }, [jwtRef, listId]);

  // The one way a categories switch value reaches the screen: the owner's tap, a failed save's
  // rollback, a realtime UPDATE, or a read's answer. A change bumps switchGenRef, so an answer
  // that left before it can't put back what it replaced. Off also clears the categories on
  // screen: the server deleted them (set_list_categories_enabled). An item left holding a
  // deleted category would sit under "Sorting…" after turning back on, because retrySorting
  // only fills items with no category.
  const applyCategoriesSwitch = useCallback((enabled: boolean) => {
    if (enabled !== categoriesEnabledRef.current) switchGenRef.current++;
    categoriesEnabledRef.current = enabled;
    setCategoriesEnabled(enabled);
    if (!enabled) {
      setCategories((prev) => (prev.length ? [] : prev));
      setItems((prev) => clearItemCategories(prev));
    }
  }, []);

  // While the switch is off on screen, no item carries a category: this catches an answer that
  // left before an off and came back after it.
  const withSwitch = useCallback(
    (rows: ItemData[]) => (categoriesEnabledRef.current ? rows : clearItemCategories(rows)),
    []
  );

  // One load at a time writes the screen. A quiet re-check that starts while a load is out
  // joins it: the reconnect that a Retry tap's focus starts would otherwise race that Retry.
  // A load the user asked for (Retry, a late token) starts afresh, and the older one then
  // writes nothing and resolves with the newer one's outcome.
  const loadGenRef = useRef(0);
  const doneGenRef = useRef(0);
  const latestLoadRef = useRef<Promise<boolean>>(Promise.resolve(false));

  // Loads the list's details and items. Resolves true when the list loaded; false when it
  // did not (the error screen shows), so a caller can tell a good load from a failed one.
  // `silent`: the reconnect's re-check over the error screen, which stays as it is until the
  // answer is in. A reconnect runs in the same moment as the first tap after a return to the
  // app; swapping in the skeleton would move the button under the finger, and iOS drops that tap.
  const fetchItems = useCallback(({ silent = false }: { silent?: boolean } = {}): Promise<boolean> => {
    if (silent && doneGenRef.current < loadGenRef.current) return latestLoadRef.current;
    const gen = ++loadGenRef.current;
    const overtaken = () => gen !== loadGenRef.current;
    const failed = (gone: boolean): Promise<boolean> | boolean => {
      if (overtaken()) return latestLoadRef.current;
      // A quiet re-check that couldn't get an answer leaves a not-found view up; the ref
      // still says no answer of 403/404 came, so the reconnect retries.
      unavailableRef.current = gone;
      if (gone || !silent) setNotFound(gone);
      setError(true);
      setLoading(false);
      return false;
    };
    // The switch as this load reads it (the list summary, then the newer items answer), unless
    // it changed on screen while the load was out: the owner's tap or a realtime UPDATE is newer.
    let switchGen = switchGenRef.current;
    const applyReadSwitch = (enabled: boolean) => {
      if (switchGen !== switchGenRef.current) {
        console.warn("[List] Load's categories switch dropped: it changed on screen meanwhile", { listId });
        return;
      }
      applyCategoriesSwitch(enabled);
      switchGen = switchGenRef.current;
    };
    const run = async (): Promise<boolean> => {
      const jwt = jwtRef.current;
      if (!jwt) {
        // The session gave up signing in: leave the placeholders for the error screen, where
        // the connection banner says why. A later token loads the list (the page reruns this).
        console.warn("[List] Load skipped, no session:", { listId });
        unavailableRef.current = false;
        setNotFound(false);
        setError(true);
        setLoading(false);
        return false;
      }
      try {
        // Retry and a late token start over the error screen: show the skeleton while the
        // request is out, never an empty list that accepts input.
        if (!silent) {
          setLoading(true);
          setError(false);
          unavailableRef.current = false;
          setNotFound(false);
        }
        // Fetch list info
        let currentListType: ListType = "regular";
        type ListSummary = {
          id: string;
          name: string;
          is_shared?: boolean;
          type?: string;
          icon?: string | null;
          color?: string | null;
          categories_enabled?: boolean;
          role?: "owner" | "edit" | "view";
        };

        const findList = async (url: string): Promise<ListSummary | undefined> => {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${jwt}` },
          });
          // A failed lookup throws to the Retry screen below: without the list's details the
          // header is blank and a grocery list would open as a regular one.
          throwIfNotOk(res, "Load lists");
          const all: ListSummary[] = await res.json();
          return all.find((l) => l.id === listId);
        };

        // The archived view is excluded from the default response, so a list
        // opened from the Archived tab or a Telegram deep link needs a second
        // look. Only on a miss — firing both would double every list open.
        const currentList =
          (await findList("/api/lists")) ??
          (await findList("/api/lists?archived=1"));
        if (overtaken()) return latestLoadRef.current;

        if (currentList) {
          setListName(currentList.name);
          setIsShared(currentList.is_shared ?? false);
          // A list an old app version created with the retired reminders type during the deploy window reads as a
          // regular list until migration 029 retires the value.
          currentListType = currentList.type === "grocery" ? "grocery" : "regular";
          setListType(currentListType);
          setListIcon((currentList.icon ?? null) as ListIconName | null);
          setListColor((currentList.color ?? null) as ListColor | null);
          applyReadSwitch(currentList.categories_enabled !== false);
        }

        // Fetch items
        const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (overtaken()) return latestLoadRef.current;
        if (res.ok) {
          const { items: fetchedItems, categories_enabled: readEnabled } = await res.json();
          if (overtaken()) return latestLoadRef.current;
          if (typeof readEnabled === "boolean") applyReadSwitch(readEnabled);
          const FOUR_HOURS = 4 * 60 * 60 * 1000;
          const now = Date.now();
          const canSave = currentList?.role !== "view";
          const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string; skipped_at?: string | null; recurring?: boolean; completed?: boolean; completed_at?: string | null; deleted_at?: string | null }) => {
            const base = {
              ...item,
              creator_name: item.users?.name ?? null,
              editor_name: item.editor?.name ?? null,
              _pending: false,
              users: undefined,
              editor: undefined,
            };
            // Auto-unskip and auto-respawn are saved as changes through the list's sync
            // engine, like the user's own, so they stay in order with them and are retried.
            // A view-only collaborator can't save them (the server refuses with 403, which the
            // engine reports as a sync error), so their list only shows the result.
            // Auto-unskip items older than 4 hours
            if (base.skipped_at && now - new Date(base.skipped_at).getTime() > FOUR_HOURS) {
              if (canSave) getSyncEngine(listId).add({
                id: genMutId(),
                type: "skip",
                payload: { listId, itemId: base.id, skipped: false, at: new Date(now).toISOString() },
              });
              return { ...base, skipped_at: null };
            }
            // Auto-respawn recurring items past the same 4-hour threshold, or a paused one whose week has ended.
            // Deleting is final — shouldRespawn refuses any row carrying deleted_at.
            if (shouldRespawn(base, now)) {
              if (canSave) getSyncEngine(listId).add({
                id: genMutId(),
                type: "restore-recurring",
                payload: { listId, itemId: base.id },
              });
              return { ...base, completed: false, completed_at: null, skipped_at: null, ordered_at: null, paused_until: null, position: Date.now() };
            }
            return base;
          });
          setItems(withSwitch(mapped));
          if (currentListType === "grocery" && categoriesEnabledRef.current) await loadCategories();
          if (overtaken()) return latestLoadRef.current;
          // The list loaded, categories too: it replaces the skeleton, or in one step the
          // error screen a quiet re-check left up.
          unavailableRef.current = false;
          setNotFound(false);
          setError(false);
          setLoading(false);
          return true;
        }
        console.warn("[List] Load items failed:", { listId, status: res.status });
        return failed(res.status === 403 || res.status === 404);
      } catch (e) {
        console.error("[List] Fetch error:", e);
        return failed(false);
      }
    };
    const load = run();
    latestLoadRef.current = load;
    // run() never rejects: every failure resolves false.
    void load.finally(() => {
      if (doneGenRef.current < gen) doneGenRef.current = gen;
    });
    return load;
  }, [jwtRef, listId, loadCategories, applyCategoriesSwitch, withSwitch]);

  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const base = itemsRef.current;
    const gen = switchGenRef.current;
    try {
      const engine = getSyncEngine(listId);
      // What is on its way as the GET leaves: a change that lands before the answer must
      // still win over the older snapshot (its echo may never come, and a deleted row isn't
      // on screen for its echo to find).
      const pendingAtStart = engine.pendingSnapshot();
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // The list is gone for this user (deleted, or access removed while away): show the
      // not-found view, as the first load does. Resolve, because retrying can never clear it.
      if (res.status === 403 || res.status === 404) {
        console.warn("[List] Background refresh: list unavailable:", { listId, status: res.status });
        unavailableRef.current = true;
        setNotFound(true);
        setError(true);
        return;
      }
      // Any other failed refresh throws, so the reconnect orchestrator retries instead of
      // reporting a stale screen as connected.
      throwIfNotOk(res, "Background refresh");
      const { items: fetchedItems, categories_enabled: readEnabled } = await res.json();
      // The server's switch, unless it changed on screen while the GET was out. Applied before
      // the merge, so the merge clears categories by the fresh value.
      if (typeof readEnabled === "boolean") {
        if (gen === switchGenRef.current) applyCategoriesSwitch(readEnabled);
        else console.warn("[List] Refresh's categories switch dropped: it changed on screen meanwhile", { listId });
      }

      const mapped: ItemData[] = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
        };
      });
      // Merge, never replace: a change the server hasn't confirmed, or that was on its way
      // when the GET left, keeps its fields on screen.
      const pendingFields = (id: string) =>
        new Set([...engine.pendingFields(id), ...engine.pendingFieldsOf(pendingAtStart, id)]);
      setItems((prev) => withSwitch(mergeRefresh(prev, base, mapped, pendingFields)));
      if (listType === "grocery" && categoriesEnabledRef.current) await loadCategories();
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
      throw e;
    }
  }, [jwtRef, listId, listType, loadCategories, applyCategoriesSwitch, withSwitch]);

  // The "Sorting…" retry: re-request the list so GET /items schedules a sort, and copy in a
  // category the server already has for an item still unsorted on screen. Unlike
  // refreshItems it replaces nothing else, so a change in flight or waiting in the queue is
  // never undone, and it sends nothing from the queue. An answer that left before the switch
  // changed on screen writes and loads nothing.
  const retrySorting = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const gen = switchGenRef.current;
    try {
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        console.warn("[List] Sorting retry failed:", { listId, status: res.status });
        return;
      }
      const { items: fetched, categories_enabled: readEnabled } = await res.json();
      if (gen !== switchGenRef.current) {
        console.warn("[List] Sorting retry answer dropped: the categories switch changed meanwhile", { listId });
        return;
      }
      // The server's switch first: off copies nothing and loads no categories.
      if (typeof readEnabled === "boolean") applyCategoriesSwitch(readEnabled);
      if (!categoriesEnabledRef.current) return;
      const server = new Map<string, { category_id?: string | null; category_locked?: boolean }>(
        (fetched ?? []).map((i: { id: string; category_id?: string | null; category_locked?: boolean }) => [i.id, i])
      );
      setItems((prev) =>
        prev.map((i) => {
          if (i.category_id) return i;
          const s = server.get(i.id);
          return s?.category_id ? { ...i, category_id: s.category_id, category_locked: s.category_locked ?? false } : i;
        })
      );
    } catch (e) {
      console.error("[List] Sorting retry error:", e);
      return;
    }
    // Only reached with the switch on: an answer that reads it off returned above.
    if (listType === "grocery") await loadCategories();
  }, [jwtRef, listId, listType, loadCategories, applyCategoriesSwitch]);

  return { listName, setListName, items, setItems, loading, error, notFound, unavailableRef, isShared, setIsShared, listType, setListType, listIcon, setListIcon, listColor, setListColor, categories, setCategories, categoriesEnabled, applyCategoriesSwitch, loadCategories, fetchItems, refreshItems, retrySorting };
}
