"use client";

import { useCallback } from "react";
import type { ItemData } from "@/src/types";
import { getTelegramWebApp } from "@/src/types/telegram";
import { genMutId } from "@/src/utils/list-helpers";

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
  listType?: "regular" | "reminders" | "grocery";
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
  listType,
  t,
}: UseItemHandlersParams) {
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
        position,
        created_by: userId,
        creator_name: null,
        edited_by: null,
        editor_name: null,
        _pending: true,
        _justAdded: true,
      };
      setItems((prev) => [newItem, ...prev]);

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

      // Check for duplicate (skip in reminders lists — duplicates are expected)
      if (listType !== "reminders") {
        const existing = items.find(
          (i) => !i.completed && !i.deleted_at && !i.skipped_at && i.text.toLowerCase() === text.toLowerCase()
        );
        if (existing) {
          const tg = getTelegramWebApp();
          tg?.HapticFeedback?.notificationOccurred("warning");
          setDuplicateWarning(t("items.duplicateWarning"));
          setTimeout(() => setDuplicateWarning(null), 2500);
        }
      }

      if (recycleId) {
        // Recycle: optimistic update
        setItems((prev) =>
          prev.map((i) =>
            i.id === recycleId
              ? { ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, created_by: userId, creator_name: null }
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
      const item = items.find((i) => i.id === itemId);

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

          // For recurring items in reminders lists: create next occurrence
          if (completed && listType === "reminders" && item?.my_reminder_recurrence && item?.my_remind_at) {
            const currentRemindAt = new Date(item.my_remind_at);
            let nextRemindAt: Date;
            switch (item.my_reminder_recurrence) {
              case "daily":
                nextRemindAt = new Date(currentRemindAt.getTime() + 24 * 60 * 60 * 1000);
                break;
              case "weekly":
                nextRemindAt = new Date(currentRemindAt.getTime() + 7 * 24 * 60 * 60 * 1000);
                break;
              case "monthly":
                nextRemindAt = new Date(currentRemindAt);
                nextRemindAt.setMonth(nextRemindAt.getMonth() + 1);
                break;
              default:
                nextRemindAt = new Date(currentRemindAt.getTime() + 24 * 60 * 60 * 1000);
            }

            // Create new item with same text
            const createRes = await fetch(`/api/lists/${listId}/items`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text: item.text, idempotencyKey: genMutId(), position: Date.now() }),
            });
            if (createRes.ok) {
              const { items: created } = await createRes.json();
              if (created?.[0]) {
                // Create reminder on the new item
                await fetch(`/api/lists/${listId}/items/${created[0].id}/reminder`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${jwt}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    remind_at: nextRemindAt.toISOString(),
                    is_shared: item.my_reminder_shared ?? false,
                    recurrence: item.my_reminder_recurrence,
                  }),
                });
                // Add the new item to local state
                setItems((prev) => [
                  {
                    ...created[0],
                    creator_name: null,
                    editor_name: null,
                    _pending: false,
                    my_remind_at: nextRemindAt.toISOString(),
                    my_reminder_id: null,
                    my_reminder_shared: item.my_reminder_shared ?? false,
                    my_reminder_recurrence: item.my_reminder_recurrence,
                  },
                  ...prev,
                ]);
              }
            }
          }
        },
      });
    },
    [jwtRef, listId, listType, items, addMutation, setItems]
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
            // Restore on server
            const jwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                itemId,
                deleted_at: null,
              }),
            });
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
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction]
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
    [jwtRef, listId, addMutation, setItems]
  );

  const handleRemoveDuplicates = useCallback(
    (text: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      // Find all non-deleted items matching text (case-insensitive)
      const matches = items
        .filter((i) => !i.deleted_at && i.text.toLowerCase() === text.toLowerCase())
        .sort((a, b) => b.position - a.position);

      if (matches.length <= 1) return;

      // Keep the first (highest position = most recent), remove the rest
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
          // Restore on server
          const currentJwt = jwtRef.current;
          for (const item of duplicatesToRemove) {
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: item.id, deleted_at: null }),
            });
          }
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
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction]
  );

  const handleClearCompleted = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("warning");

    const completedItems = items.filter(
      (i) => i.completed && !i.deleted_at
    );
    // Optimistic
    setItems((prev) => prev.filter((i) => !i.completed));

    const timeout = setTimeout(() => setUndoAction(null), 4000);
    setUndoAction({
      message: t('items.clearedCount', { count: completedItems.length }),
      undo: () => {
        clearTimeout(timeout);
        setUndoAction(null);
        setItems((prev) => [...prev, ...completedItems]);
        // Restore on server
        const currentJwt = jwtRef.current;
        for (const item of completedItems) {
          fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: item.id, deleted_at: null }),
          });
        }
      },
      timeout,
    });

    await fetch(`/api/lists/${listId}/items/clear-completed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }, [jwtRef, listId, items, t, setItems, setUndoAction]);

  const handleRemind = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      await fetch(`/api/lists/${listId}/remind`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      setReminderToast(t("items.reminderSent"));
      setTimeout(() => setReminderToast(null), 2500);
    } catch (e) {
      console.error("[List] Remind error:", e);
    }
  }, [jwtRef, listId, t, setReminderToast]);

  const handleSetReminder = useCallback(
    async (itemId: string, remindAt: string, isSharedReminder: boolean, recurrence?: string) => {
      const jwt = jwtRef.current;
      if (!jwt) return;
      try {
        const res = await fetch(`/api/lists/${listId}/items/${itemId}/reminder`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ remind_at: remindAt, is_shared: isSharedReminder, recurrence }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setReminderToast(err?.error || "Failed to set reminder");
          setTimeout(() => setReminderToast(null), 3000);
          return;
        }
        const data = await res.json();
        // Update local state with the reminder info
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, my_remind_at: data.remind_at, my_reminder_id: data.id, my_reminder_shared: data.is_shared, my_reminder_recurrence: data.recurrence }
              : i
          )
        );
        setReminderToast(t("reminder.sent"));
        setTimeout(() => setReminderToast(null), 2500);
      } catch (e) {
        console.error("[List] Set reminder error:", e);
      }
    },
    [jwtRef, listId, t, setItems, setReminderToast]
  );

  const handleCancelReminder = useCallback(
    async (itemId: string, reminderId: string) => {
      const jwt = jwtRef.current;
      if (!jwt) return;
      try {
        const res = await fetch(`/api/lists/${listId}/items/${itemId}/reminder/${reminderId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) throw new Error(`Cancel reminder failed: ${res.status}`);
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, my_remind_at: null, my_reminder_id: null, my_reminder_shared: false, my_reminder_recurrence: null }
              : i
          )
        );
        setReminderToast(t("reminder.cancelled"));
        setTimeout(() => setReminderToast(null), 2500);
      } catch (e) {
        console.error("[List] Cancel reminder error:", e);
      }
    },
    [jwtRef, listId, t, setItems, setReminderToast]
  );

  const handleUpdateReminder = useCallback(
    async (itemId: string, reminderId: string, updates: { recurrence?: string; is_shared?: boolean }) => {
      const jwt = jwtRef.current;
      if (!jwt) return;
      try {
        const res = await fetch(`/api/lists/${listId}/items/${itemId}/reminder/${reminderId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          setReminderToast(err?.error || "Failed to update reminder");
          setTimeout(() => setReminderToast(null), 3000);
          return;
        }
        const data = await res.json();
        setItems((prev) =>
          prev.map((i) =>
            i.id === itemId
              ? { ...i, my_reminder_recurrence: data.recurrence, my_reminder_shared: data.is_shared }
              : i
          )
        );
      } catch (e) {
        console.error("[List] Update reminder error:", e);
      }
    },
    [jwtRef, listId, setItems, setReminderToast]
  );

  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleSetReminder, handleUpdateReminder, handleCancelReminder };
}
