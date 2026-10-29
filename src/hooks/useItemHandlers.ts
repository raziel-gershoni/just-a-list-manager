"use client";

import { useCallback } from "react";
import type { ItemData } from "@/src/types";
import { getTelegramWebApp } from "@/src/types/telegram";
import { genMutId, isActiveItem } from "@/src/utils/list-helpers";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import { computeClearCompleted } from "@/src/utils/clear-completed";
import { computeUnskipAll } from "@/src/utils/unskip-all";
import { findCompletedExactMatch } from "@/src/utils/search-completed-items";
import { throwIfNotOk } from "@/src/utils/http";
import { restoreItemsOnServer, type RestoreBody } from "@/src/utils/item-restore";

interface UseItemHandlersParams {
  listId: string;
  jwtRef: React.RefObject<string | null>;
  userId: string | null;
  items: ItemData[];
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown> }) => void;
  setUndoAction: React.Dispatch<React.SetStateAction<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>>;
  setDuplicateWarning: React.Dispatch<React.SetStateAction<string | null>>;
  setReminderToast: React.Dispatch<React.SetStateAction<string | null>>;
  setErrorToast: React.Dispatch<React.SetStateAction<string | null>>;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useItemHandlers({
  listId,
  jwtRef,
  userId,
  items,
  setItems,
  addMutation,
  setUndoAction,
  setDuplicateWarning,
  setReminderToast,
  setErrorToast,
  t,
}: UseItemHandlersParams) {
  // One toast for a background save that failed and was put back on screen.
  const showSyncError = useCallback(() => {
    setErrorToast(t("items.syncError"));
    setTimeout(() => setErrorToast(null), 3000);
  }, [setErrorToast, t]);

  // Sends an Undo's item PATCHes. `revert` puts the items whose restore failed back to
  // how they were before the Undo, so the screen matches the server.
  const restoreOrRevert = useCallback(
    (bodies: RestoreBody[], revert: (failed: Set<string>) => void) => {
      void restoreItemsOnServer(listId, jwtRef.current, bodies).then((failed) => {
        if (failed.length === 0) return;
        revert(new Set(failed));
        showSyncError();
      });
    },
    [listId, jwtRef, showSyncError]
  );

  // Revert for a restore of deleted items: they leave the screen again.
  const removeAgain = useCallback(
    (failed: Set<string>) => setItems((prev) => prev.filter((i) => !failed.has(i.id))),
    [setItems]
  );

  const addSingleItem = useCallback(
    (typed: string) => {
      // The server stores normalizeForStorage(text). Showing and sending that same text lets
      // the realtime INSERT find this row, so the item never shows twice.
      const text = normalizeForStorage(typed);
      if (!text) return;
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      const position = Date.now();
      const mutId = genMutId();

      const newItem: ItemData = {
        id: tempId,
        text,
        completed: false,
        completed_at: null,
        deleted_at: null,
        skipped_at: null,
        ordered_at: null,
        recurring: false,
        position,
        created_by: userId,
        creator_name: null,
        edited_by: null,
        editor_name: null,
        _pending: true,
        _justAdded: true,
      };
      setItems((prev) => [newItem, ...prev]);

      // Clear animation flag after it plays
      setTimeout(() => {
        setItems((prev) => prev.map((i) => i.id === tempId ? { ...i, _justAdded: false } : i));
      }, 300);

      // The page's create success handler swaps in the server's row.
      addMutation({
        id: mutId,
        type: "create",
        payload: { listId, text, position, idempotencyKey: mutId, tempId },
      });
    },
    [listId, addMutation, userId, setItems]
  );

  // Brings a completed item back to the active list: the suggestion tap, and a typed add
  // whose text matches a completed item.
  const recycleCompleted = useCallback(
    (recycleId: string, text: string) => {
      setItems((prev) =>
        prev.map((i) =>
          i.id === recycleId
            ? { ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, created_by: userId, creator_name: null }
            : i
        )
      );
      addMutation({ id: genMutId(), type: "recycle", payload: { listId, recycleId, text } });
    },
    [listId, addMutation, userId, setItems]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      // No JWT guard here — items are added optimistically and queued.
      // The sync engine sends them once a JWT exists.

      // Check for duplicate
      const normalized = normalizeForCompare(text);
      const existing = items.find(
        (i) => !i.completed && !i.deleted_at && !i.skipped_at && normalizeForCompare(i.text) === normalized
      );
      if (existing) {
        const tg = getTelegramWebApp();
        tg?.HapticFeedback?.notificationOccurred("warning");
        setDuplicateWarning(t("items.duplicateWarning"));
        setTimeout(() => setDuplicateWarning(null), 2500);
      }

      if (recycleId) {
        recycleCompleted(recycleId, text);
      } else {
        // Split comma-separated items into individual mutations
        const segments = text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        // A typed item with the same text as a completed one recycles it, exactly like a
        // tap on its suggestion (owner decision 1, 2026-10-29 sync spec). Each completed
        // item is reused at most once per add, so "milk, milk" recycles one and adds one.
        const used = new Set<string>();
        for (const segment of segments) {
          const match = findCompletedExactMatch(items, segment, used);
          if (match) {
            used.add(match.id);
            recycleCompleted(match.id, match.text);
          } else {
            addSingleItem(segment);
          }
        }
      }
    },
    [addSingleItem, recycleCompleted, items, t, setDuplicateWarning]
  );

  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // Tap time: the server stamps completed_at with it, even when the change syncs later.
      const at = new Date().toISOString();
      // Animate out then update
      if (completed) {
        setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, _exiting: true } : i));
        await new Promise((r) => setTimeout(r, 200));
      }

      // Optimistic
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                completed,
                completed_at: completed ? at : null,
                _exiting: false,
              }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "toggle",
        payload: { listId, itemId, completed, at },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleDelete = useCallback(
    async (itemId: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      const deletedItem = items.find((i) => i.id === itemId);
      // Animate out then remove. Kept so an Undo inside the animation can cancel it.
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, _exiting: true } : i));
      const removal = setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== itemId)), 200);

      // Show undo toast
      const timeout = setTimeout(() => setUndoAction(null), 4000);

      setUndoAction({
        message: t('items.deleted'),
        undo: () => {
          clearTimeout(timeout);
          clearTimeout(removal);
          setUndoAction(null);
          if (deletedItem) {
            // Replaces the exiting copy when the Undo comes inside the animation.
            setItems((prev) => [...prev.filter((i) => i.id !== itemId), deletedItem]);
            // Queued on the item's chain, so it lands after the delete (in flight or kept
            // for retry) and replays offline like any other change.
            addMutation({ id: genMutId(), type: "restore", payload: { listId, itemId } });
          }
        },
        timeout,
      });

      addMutation({ id: genMutId(), type: "delete", payload: { listId, itemId } });
    },
    [listId, items, addMutation, t, setItems, setUndoAction]
  );

  const handleEditItem = useCallback(
    async (itemId: string, newText: string) => {
      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, text: newText, edited_by: userId, editor_name: null } : i))
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "edit",
        payload: { listId, itemId, text: newText },
      });
    },
    [listId, addMutation, userId, setItems]
  );

  // Server side of a skip/unskip. Shared by handleSkip and Restore all, which uses
  // it for items still waiting for their offline create.
  // `at` is the tap time the server stamps skipped_at with.
  const enqueueSkip = useCallback(
    (itemId: string, skipped: boolean, at: string) => {
      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "skip",
        payload: { listId, itemId, skipped, at },
      });
    },
    [listId, addMutation]
  );

  const handleSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      const at = new Date().toISOString();

      // Optimistic update
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, skipped_at: skipped ? at : null }
            : i
        )
      );

      enqueueSkip(itemId, skipped, at);
    },
    [enqueueSkip, setItems]
  );

  // "Restore all" on the Not available section: every skipped item goes back to the
  // active list, in its old position. No undo: the action is non-destructive, and any
  // item can be skipped again on its own.
  const handleRestoreSkipped = useCallback(() => {
    const { affectedIds } = computeUnskipAll(items);
    if (affectedIds.length === 0) return;

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");

    setItems((prev) => computeUnskipAll(prev).next);

    // One request for the synced items, scoped to their ids so a late replay can't
    // restore anything skipped after this tap. An item still waiting for its create has a
    // temp- id the server doesn't know; its own skip mutation waits behind the create in
    // the sync engine, which sends it with the real id.
    const at = new Date().toISOString();
    const itemIds: string[] = [];
    for (const id of affectedIds) {
      if (id.startsWith("temp-")) enqueueSkip(id, false, at);
      else itemIds.push(id);
    }
    if (itemIds.length === 0) return;

    addMutation({
      id: genMutId(),
      type: "unskip-all",
      payload: { listId, itemIds },
    });
  }, [listId, items, addMutation, enqueueSkip, setItems]);

  const handleOrder = useCallback(
    (itemId: string, ordered: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      const at = new Date().toISOString();

      // Optimistic update — ordered and skipped are mutually exclusive
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, ordered_at: ordered ? at : null, skipped_at: ordered ? null : i.skipped_at }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "order",
        payload: { listId, itemId, ordered, at },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleSetRecurring = useCallback(
    (itemId: string, recurring: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, recurring } : i))
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "set-recurring",
        payload: { listId, itemId, recurring },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleRestoreRecurring = useCallback(
    (itemId: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, position: Date.now() }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "restore-recurring",
        payload: { listId, itemId },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleRemoveDuplicates = useCallback(
    (text: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      // Find all non-deleted items matching text (normalized)
      const normalized = normalizeForCompare(text);
      // An active copy is kept (the highest-position one if several), else the highest-position copy.
      // Completed and skipped copies are history: a drag renumbers active rows 1..N while
      // done rows keep their large creation-time positions, so position alone would keep them.
      const matches = items
        .filter((i) => !i.deleted_at && normalizeForCompare(i.text) === normalized)
        .sort((a, b) => Number(isActiveItem(b)) - Number(isActiveItem(a)) || b.position - a.position);

      if (matches.length <= 1) return;

      // Keep the first match, remove the rest
      const duplicatesToRemove = matches.slice(1);
      const removeIds = new Set(duplicatesToRemove.map((i) => i.id));

      // Optimistic removal
      setItems((prev) => prev.filter((i) => !removeIds.has(i.id)));

      // Show undo toast
      const timeout = setTimeout(() => setUndoAction(null), 4000);
      setUndoAction({
        message: t("items.removedDuplicates", { count: duplicatesToRemove.length }),
        undo: () => {
          clearTimeout(timeout);
          setUndoAction(null);
          setItems((prev) => [...prev.filter((i) => !removeIds.has(i.id)), ...duplicatesToRemove]);
          // One restore per duplicate, each queued behind that duplicate's delete.
          for (const item of duplicatesToRemove) {
            addMutation({ id: genMutId(), type: "restore", payload: { listId, itemId: item.id } });
          }
        },
        timeout,
      });

      // Queue delete mutations
      for (const item of duplicatesToRemove) {
        addMutation({ id: genMutId(), type: "delete", payload: { listId, itemId: item.id } });
      }
    },
    [listId, items, addMutation, t, setItems, setUndoAction]
  );

  const handleClearCompleted = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("warning");

    const { cleared: completedItems } = computeClearCompleted(items);
    // The ids the screen showed: the server clears only these, never an item a collaborator
    // ticked a moment ago. An item still waiting for its offline create has a temp- id the
    // server doesn't know yet, so it is cleared on screen only.
    const itemIds = completedItems.map((i) => i.id).filter((id) => !id.startsWith("temp-"));
    // Optimistic — recurring staples stay parked, not cleared (see
    // src/utils/clear-completed.ts)
    setItems((prev) => computeClearCompleted(prev).remaining);

    // Set when the bulk POST itself failed: the server never cleared these items, so an
    // Undo tapped while it was in flight must not take them off again if its restore fails.
    let bulkFailed = false;
    const timeout = setTimeout(() => setUndoAction(null), 4000);
    setUndoAction({
      message: t('items.clearedCount', { count: completedItems.length }),
      undo: () => {
        clearTimeout(timeout);
        setUndoAction(null);
        setItems((prev) => [...prev, ...completedItems]);
        // Restore on server what the clear sent; items whose restore fails leave the screen again.
        restoreOrRevert(
          itemIds.map((itemId) => ({ itemId, deleted_at: null })),
          (failed) => {
            if (bulkFailed) return;
            removeAgain(failed);
          }
        );
      },
      timeout,
    });

    if (itemIds.length === 0) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items/clear-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
      throwIfNotOk(res, "Clear completed");
    } catch (err) {
      // Not in the offline queue: put the items back so the screen matches the server.
      bulkFailed = true;
      console.error("[List] Clear completed failed:", { listId }, err);
      clearTimeout(timeout);
      setUndoAction((prev) => (prev?.timeout === timeout ? null : prev));
      // Skip items already back on screen (an Undo tapped before this failed).
      setItems((prev) => {
        const present = new Set(prev.map((i) => i.id));
        return [...prev, ...completedItems.filter((i) => !present.has(i.id))];
      });
      showSyncError();
    }
  }, [jwtRef, listId, items, t, setItems, setUndoAction, restoreOrRevert, removeAgain, showSyncError]);

  const handleUnmarkAllDone = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;

    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;
    // The ids the screen showed, as Clear completed sends them; temp- items are unmarked on
    // screen only.
    const itemIds = affectedIds.filter((id) => !id.startsWith("temp-"));
    // Completion times before the flip, put back if the server refuses it.
    const completedAtById = new Map(
      items.filter((i) => affectedIds.includes(i.id)).map((i) => [i.id, i.completed_at] as const)
    );

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");

    // Optimistic: flip completed -> active
    setItems((prev) => computeUnmarkCompleted(prev).next);

    const idSet = new Set(affectedIds);
    // Set when the bulk POST itself failed: the server never unmarked these items, so an
    // Undo tapped while it was in flight must not uncheck them if its restore fails.
    let bulkFailed = false;
    const timeout = setTimeout(() => setUndoAction(null), 4000);
    setUndoAction({
      message: t('items.unmarkedCount', { count: affectedIds.length }),
      undo: () => {
        clearTimeout(timeout);
        setUndoAction(null);
        // Re-check optimistically
        setItems((prev) =>
          prev.map((i) =>
            idSet.has(i.id)
              ? { ...i, completed: true, completed_at: new Date().toISOString() }
              : i
          )
        );
        // Restore on server; items whose restore fails are unchecked again.
        restoreOrRevert(
          itemIds.map((id) => ({ itemId: id, completed: true })),
          (failed) => {
            if (bulkFailed) return;
            setItems((prev) =>
              prev.map((i) => (failed.has(i.id) ? { ...i, completed: false, completed_at: null } : i))
            );
          }
        );
      },
      timeout,
    });

    if (itemIds.length === 0) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items/unmark-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
      throwIfNotOk(res, "Unmark all");
    } catch (err) {
      // Not in the offline queue: re-check the items so the screen matches the server.
      bulkFailed = true;
      console.error("[List] Unmark all failed:", { listId }, err);
      clearTimeout(timeout);
      setUndoAction((prev) => (prev?.timeout === timeout ? null : prev));
      setItems((prev) =>
        prev.map((i) =>
          completedAtById.has(i.id)
            ? { ...i, completed: true, completed_at: completedAtById.get(i.id) ?? null }
            : i
        )
      );
      showSyncError();
    }
  }, [jwtRef, listId, items, t, setItems, setUndoAction, restoreOrRevert, showSyncError]);

  const sendSignal = useCallback(
    async (endpoint: "remind" | "ready", successKey: string) => {
      const jwt = jwtRef.current;
      if (!jwt) return;
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      try {
        const res = await fetch(`/api/lists/${listId}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) {
          setErrorToast(t("items.signalError"));
          setTimeout(() => setErrorToast(null), 3000);
          return;
        }
        const data = await res.json().catch((err) => {
          console.warn(`[List] ${endpoint} response was not valid JSON, assuming sent: 0:`, err);
          return { sent: 0 };
        });
        setReminderToast(t(data.sent === 0 ? "items.signalNoRecipients" : successKey));
        setTimeout(() => setReminderToast(null), 2500);
      } catch (e) {
        console.error(`[List] ${endpoint} error:`, e);
        setErrorToast(t("items.signalError"));
        setTimeout(() => setErrorToast(null), 3000);
      }
    },
    [jwtRef, listId, t, setReminderToast, setErrorToast]
  );

  const handleRemind = useCallback(
    () => sendSignal("remind", "items.reminderSent"),
    [sendSignal]
  );

  const handleReady = useCallback(
    () => sendSignal("ready", "items.readySent"),
    [sendSignal]
  );

  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRestoreSkipped, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady };
}
