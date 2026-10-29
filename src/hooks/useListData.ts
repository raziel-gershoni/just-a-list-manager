"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ItemData, ListCategory } from "@/src/types";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";
import { shouldRespawn } from "@/src/utils/recurring-respawn";
import { sortCategories } from "@/src/utils/category-state";
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
  const [isShared, setIsShared] = useState(false);
  const [listType, setListType] = useState<ListType>("regular");
  const [listIcon, setListIcon] = useState<ListIconName | null>(null);
  const [listColor, setListColor] = useState<ListColor | null>(null);
  const [categories, setCategories] = useState<ListCategory[]>([]);
  // The rows on screen as of the last render: a refresh compares them with the rows on screen
  // when its answer comes back, to tell what changed while the GET was out.
  const itemsRef = useRef<ItemData[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // The list works without categories (items show under "Sorting…"), so a failed request
  // (an error status or no answer at all) is only logged: it must never turn into the
  // list's error screen.
  const loadCategories = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      const res = await fetch(`/api/lists/${listId}/categories`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const { categories: fetched } = await res.json();
        setCategories(sortCategories(fetched ?? []));
      } else {
        console.warn("[List] Categories load failed:", { listId, status: res.status });
      }
    } catch (e) {
      console.error("[List] Categories fetch error:", e);
    }
  }, [jwtRef, listId]);

  const fetchItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) {
      // The session gave up signing in: leave the placeholders for the error screen, where
      // the connection banner says why. A later token loads the list (the page reruns this).
      console.warn("[List] Load skipped, no session:", { listId });
      setNotFound(false);
      setError(true);
      setLoading(false);
      return;
    }
    try {
      setError(false);
      setNotFound(false);
      // Fetch list info
      let currentListType: ListType = "regular";
      type ListSummary = {
        id: string;
        name: string;
        is_shared?: boolean;
        type?: string;
        icon?: string | null;
        color?: string | null;
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

      if (currentList) {
        setListName(currentList.name);
        setIsShared(currentList.is_shared ?? false);
        // A list an old app version created with the retired reminders type during the deploy window reads as a
        // regular list until migration 029 retires the value.
        currentListType = currentList.type === "grocery" ? "grocery" : "regular";
        setListType(currentListType);
        setListIcon((currentList.icon ?? null) as ListIconName | null);
        setListColor((currentList.color ?? null) as ListColor | null);
      }

      // Fetch items
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const { items: fetchedItems } = await res.json();
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
          // Auto-respawn recurring items past the same 4-hour threshold.
          // Deleting is final — shouldRespawn refuses any row carrying deleted_at.
          if (shouldRespawn(base, now)) {
            if (canSave) getSyncEngine(listId).add({
              id: genMutId(),
              type: "restore-recurring",
              payload: { listId, itemId: base.id },
            });
            return { ...base, completed: false, completed_at: null, skipped_at: null, ordered_at: null, position: Date.now() };
          }
          return base;
        });
        setItems(mapped);
        if (currentListType === "grocery") await loadCategories();
      } else {
        console.warn("[List] Load items failed:", { listId, status: res.status });
        setNotFound(res.status === 403 || res.status === 404);
        setError(true);
      }
    } catch (e) {
      console.error("[List] Fetch error:", e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [jwtRef, listId, loadCategories]);

  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const base = itemsRef.current;
    try {
      const engine = getSyncEngine(listId);
      // What is on its way as the GET leaves: a change that lands before the answer must
      // still win over the older snapshot (its echo may never come, and a deleted row isn't
      // on screen for its echo to find).
      const pendingAtStart = engine.pendingSnapshot();
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // A failed refresh throws, so the reconnect orchestrator retries instead of reporting a
      // stale screen as connected.
      throwIfNotOk(res, "Background refresh");
      const { items: fetchedItems } = await res.json();

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
      setItems((prev) => mergeRefresh(prev, base, mapped, pendingFields));
      if (listType === "grocery") await loadCategories();
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
      throw e;
    }
  }, [jwtRef, listId, listType, loadCategories]);

  // The "Sorting…" retry: re-request the list so GET /items schedules a sort, and copy in a
  // category the server already has for an item still unsorted on screen. Unlike
  // refreshItems it replaces nothing else, so a change in flight or waiting in the queue is
  // never undone, and it sends nothing from the queue.
  const retrySorting = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        console.warn("[List] Sorting retry failed:", { listId, status: res.status });
        return;
      }
      const { items: fetched } = await res.json();
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
    if (listType === "grocery") await loadCategories();
  }, [jwtRef, listId, listType, loadCategories]);

  return { listName, setListName, items, setItems, loading, error, notFound, isShared, setIsShared, listType, setListType, listIcon, setListIcon, listColor, setListColor, categories, setCategories, loadCategories, fetchItems, refreshItems, retrySorting };
}
