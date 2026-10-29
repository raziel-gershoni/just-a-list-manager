"use client";

import { useCallback } from "react";
import type { ItemData } from "@/src/types";
import { getTelegramWebApp } from "@/src/types/telegram";
import { genMutId } from "@/src/utils/list-helpers";
import { normalizeForCompare } from "@/src/utils/text-normalize";
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import { computeClearCompleted } from "@/src/utils/clear-completed";
import { computeUnskipAll } from "@/src/utils/unskip-all";
import { throwIfNotOk } from "@/src/utils/http";
import { restoreItemsOnServer, type RestoreBody } from "@/src/utils/item-restore";

interface UseItemHandlersParams {
  listId: string;
  jwtRef: React.RefObject<string | null>;
  userId: string | null;
  items: ItemData[];
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> }) => void;
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
    (text: string) => {
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

      addMutation({
        id: mutId,
        type: "create",
        payload: { listId, text, position, idempotencyKey: mutId, tempId },
        execute: async () => {
          const currentJwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, idempotencyKey: mutId, position }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Create failed: ${res.status}`);
          const { items: created } = await res.json();
          if (created?.[0]) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === tempId
                  ? { ...created[0], creator_name: null, editor_name: null, _pending: false }
                  : i
              )
            );
            return created[0].id;
          }
        },
      });
    },
    [jwtRef, listId, addMutation, userId, setItems]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      // No JWT guard here — items are added optimistically and queued.
      // The executor reads jwtRef.current at execution time (after reconnect).

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
        // Recycle: optimistic update
        setItems((prev) =>
          prev.map((i) =>
            i.id === recycleId
              ? { ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, created_by: userId, creator_name: null }
              : i
          )
        );

        const mutId = genMutId();
        addMutation({
          id: mutId,
          type: "recycle",
          payload: { listId, recycleId, text },
          execute: async () => {
            const currentJwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text, recycleId }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
          },
        });
      } else {
        // Split comma-separated items into individual mutations
        const segments = text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const segment of segments) {
          addSingleItem(segment);
        }
      }
    },
    [jwtRef, listId, addMutation, addSingleItem, items, t, userId, setItems, setDuplicateWarning]
  );

  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
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
                completed_at: completed ? new Date().toISOString() : null,
                _exiting: false,
              }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "toggle",
        payload: { listId, itemId, completed },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, completed }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );

  const handleDelete = useCallback(
    async (itemId: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      const deletedItem = items.find((i) => i.id === itemId);
      // Animate out then remove
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, _exiting: true } : i));
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== itemId)), 200);

      // Show undo toast
      const timeout = setTimeout(() => setUndoAction(null), 4000);

      setUndoAction({
        message: t('items.deleted'),
        undo: () => {
          clearTimeout(timeout);
          setUndoAction(null);
          if (deletedItem) {
            setItems((prev) => [...prev, deletedItem]);
            // Restore on server; if that fails, the item leaves the screen again.
            restoreOrRevert([{ itemId, deleted_at: null }], removeAgain);
          }
        },
        timeout,
      });

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "delete",
        payload: { listId, itemId },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(
            `/api/lists/${listId}/items?itemId=${itemId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${jwt}` },
              keepalive: true,
            }
          );
          if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
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
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, text: newText }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, userId, setItems]
  );

  // Server side of a skip/unskip. Shared by handleSkip and Restore all, which uses
  // it for items still waiting for their offline create.
  const enqueueSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "skip",
        payload: { listId, itemId, skipped },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, skipped }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Skip failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation]
  );

  const handleSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      // Optimistic update
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, skipped_at: skipped ? new Date().toISOString() : null }
            : i
        )
      );

      enqueueSkip(itemId, skipped);
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
    // restore anything skipped after this tap. An item still waiting for its offline
    // create has a temp- id the server doesn't know; its own skip mutation, queued
    // behind the create, restores it once the queue swaps in the real id.
    const itemIds: string[] = [];
    for (const id of affectedIds) {
      if (id.startsWith("temp-")) enqueueSkip(id, false);
      else itemIds.push(id);
    }
    if (itemIds.length === 0) return;

    addMutation({
      id: genMutId(),
      type: "unskip-all",
      payload: { listId, itemIds },
      execute: async () => {
        const jwt = jwtRef.current;
        const res = await fetch(`/api/lists/${listId}/items/unskip-all`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ itemIds }),
          keepalive: true,
        });
        if (!res.ok) throw new Error(`Restore all failed: ${res.status}`);
      },
    });
  }, [jwtRef, listId, items, addMutation, enqueueSkip, setItems]);

  const handleOrder = useCallback(
    (itemId: string, ordered: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      // Optimistic update — ordered and skipped are mutually exclusive
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, ordered_at: ordered ? new Date().toISOString() : null, skipped_at: ordered ? null : i.skipped_at }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "order",
        payload: { listId, itemId, ordered },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, ordered }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Order failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
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
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, recurring }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Set recurring failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
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
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, restoreRecurring: true }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore recurring failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );

  const handleRemoveDuplicates = useCallback(
    (text: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      // Find all non-deleted items matching text (normalized)
      const normalized = normalizeForCompare(text);
      const matches = items
        .filter((i) => !i.deleted_at && normalizeForCompare(i.text) === normalized)
        .sort((a, b) => b.position - a.position);

      if (matches.length <= 1) return;

      // Keep the highest-position match, remove the rest
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
          setItems((prev) => [...prev, ...duplicatesToRemove]);
          // Restore on server; duplicates whose restore fails leave the screen again.
          restoreOrRevert(
            duplicatesToRemove.map((item) => ({ itemId: item.id, deleted_at: null })),
            removeAgain
          );
        },
        timeout,
      });

      // Queue delete mutations
      for (const item of duplicatesToRemove) {
        const mutId = genMutId();
        addMutation({
          id: mutId,
          type: "delete",
          payload: { listId, itemId: item.id },
          execute: async () => {
            const jwt = jwtRef.current;
            const res = await fetch(
              `/api/lists/${listId}/items?itemId=${item.id}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${jwt}` },
                keepalive: true,
              }
            );
            if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
          },
        });
      }
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );

  const handleClearCompleted = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("warning");

    const { cleared: completedItems } = computeClearCompleted(items);
    // Optimistic — recurring staples stay parked, not cleared (see
    // src/utils/clear-completed.ts)
    setItems((prev) => computeClearCompleted(prev).remaining);

    const timeout = setTimeout(() => setUndoAction(null), 4000);
    setUndoAction({
      message: t('items.clearedCount', { count: completedItems.length }),
      undo: () => {
        clearTimeout(timeout);
        setUndoAction(null);
        setItems((prev) => [...prev, ...completedItems]);
        // Restore on server; items whose restore fails leave the screen again.
        restoreOrRevert(
          completedItems.map((item) => ({ itemId: item.id, deleted_at: null })),
          removeAgain
        );
      },
      timeout,
    });

    try {
      const res = await fetch(`/api/lists/${listId}/items/clear-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      throwIfNotOk(res, "Clear completed");
    } catch (err) {
      // Not in the offline queue: put the items back so the screen matches the server.
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
    // Completion times before the flip, put back if the server refuses it.
    const completedAtById = new Map(
      items.filter((i) => affectedIds.includes(i.id)).map((i) => [i.id, i.completed_at] as const)
    );

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");

    // Optimistic: flip completed -> active
    setItems((prev) => computeUnmarkCompleted(prev).next);

    const idSet = new Set(affectedIds);
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
          affectedIds.map((id) => ({ itemId: id, completed: true })),
          (failed) =>
            setItems((prev) =>
              prev.map((i) => (failed.has(i.id) ? { ...i, completed: false, completed_at: null } : i))
            )
        );
      },
      timeout,
    });

    try {
      const res = await fetch(`/api/lists/${listId}/items/unmark-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      throwIfNotOk(res, "Unmark all");
    } catch (err) {
      // Not in the offline queue: re-check the items so the screen matches the server.
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
