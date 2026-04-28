"use client";

import { useState, useCallback } from "react";
import type { ItemData } from "@/src/types";

type Reminder = {
  id: string;
  remind_at: string;
  is_shared: boolean;
  recurrence?: string;
  sent_at?: string;
};

// Pick the reminder that should drive an item's display.
// Sent (fired) wins over unsent; among sent keep latest; among unsent keep earliest.
function pickPreferredReminder(existing: Reminder | undefined, candidate: Reminder): Reminder {
  if (!existing) return candidate;
  const eSent = !!existing.sent_at;
  const cSent = !!candidate.sent_at;
  if (!eSent && cSent) return candidate;
  if (eSent && !cSent) return existing;
  if (eSent && cSent) return candidate.remind_at > existing.remind_at ? candidate : existing;
  return candidate.remind_at < existing.remind_at ? candidate : existing;
}

export function useListData(listId: string, jwtRef: React.RefObject<string | null>) {
  const [listName, setListName] = useState("");
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [listType, setListType] = useState<"regular" | "reminders" | "grocery">("regular");

  const fetchItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      setError(false);
      // Fetch list info
      let currentListType: string = "regular";
      const listsRes = await fetch("/api/lists", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (listsRes.ok) {
        const allLists = await listsRes.json();
        const currentList = allLists.find((l: { id: string; name: string; is_shared?: boolean; type?: string }) => l.id === listId);
        if (currentList) {
          setListName(currentList.name);
          setIsShared(currentList.is_shared ?? false);
          currentListType = currentList.type ?? "regular";
          setListType(currentListType as "regular" | "reminders" | "grocery");
        }
      }

      // Fetch items
      const res = await fetch(`/api/lists/${listId}/items`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const { items: fetchedItems } = await res.json();
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const now = Date.now();
        // Fetch reminders for all items in this list
        // For reminders-type lists, include sent reminders so fired items keep their time
        const remindersUrl = currentListType === "reminders"
          ? `/api/lists/${listId}/reminders?include_sent=1`
          : `/api/lists/${listId}/reminders`;
        const remindersRes = await fetch(remindersUrl, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const remindersByItem = new Map<string, Reminder>();
        if (remindersRes.ok) {
          const { reminders } = await remindersRes.json();
          for (const r of reminders || []) {
            remindersByItem.set(r.item_id, pickPreferredReminder(remindersByItem.get(r.item_id), r));
          }
        }

        const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string; skipped_at?: string | null; recurring?: boolean; completed?: boolean; completed_at?: string | null; deleted_at?: string | null }) => {
          const reminder = remindersByItem.get(item.id as string);
          const base = {
            ...item,
            creator_name: item.users?.name ?? null,
            editor_name: item.editor?.name ?? null,
            _pending: false,
            users: undefined,
            editor: undefined,
            my_remind_at: reminder?.remind_at ?? null,
            my_reminder_id: reminder?.id ?? null,
            my_reminder_shared: reminder?.is_shared ?? false,
            my_reminder_recurrence: reminder?.recurrence ?? null,
          };
          // Auto-unskip items older than 4 hours
          if (base.skipped_at && now - new Date(base.skipped_at).getTime() > FOUR_HOURS) {
            // Fire background PATCH to persist unskip
            const currentJwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: base.id, skipped: false }),
            }).catch(() => {});
            return { ...base, skipped_at: null };
          }
          // Auto-respawn recurring items past the same 4-hour threshold
          const respawnAnchor = base.completed_at ?? base.deleted_at ?? null;
          if (base.recurring && respawnAnchor && now - new Date(respawnAnchor).getTime() > FOUR_HOURS) {
            const currentJwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: base.id, restoreRecurring: true }),
            }).catch(() => {});
            return { ...base, completed: false, completed_at: null, deleted_at: null, skipped_at: null, position: Date.now() };
          }
          return base;
        });
        setItems(mapped);
      } else {
        setError(true);
      }
    } catch (e) {
      console.error("[List] Fetch error:", e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [jwtRef, listId]);

  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return;
      const { items: fetchedItems } = await res.json();

      // Re-fetch reminders so items keep their reminder data after reconnect
      const remindersUrl = listType === "reminders"
        ? `/api/lists/${listId}/reminders?include_sent=1`
        : `/api/lists/${listId}/reminders`;
      const remindersRes = await fetch(remindersUrl, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const remindersByItem = new Map<string, Reminder>();
      if (remindersRes.ok) {
        const { reminders } = await remindersRes.json();
        for (const r of reminders || []) {
          remindersByItem.set(r.item_id, pickPreferredReminder(remindersByItem.get(r.item_id), r));
        }
      }

      const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        const reminder = remindersByItem.get(item.id);
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
          my_remind_at: reminder?.remind_at ?? null,
          my_reminder_id: reminder?.id ?? null,
          my_reminder_shared: reminder?.is_shared ?? false,
          my_reminder_recurrence: reminder?.recurrence ?? null,
        };
      });
      setItems((prev) => {
        const pendingItems = prev.filter((i) => i._pending);
        const serverIds = new Set(mapped.map((i: ItemData) => i.id));

        // Count server items by text for count-aware dedup
        // (handles duplicate-text items correctly — only consume one match per server item)
        const serverTextCounts = new Map<string, number>();
        for (const item of mapped) {
          const key = item.text.toLowerCase();
          serverTextCounts.set(key, (serverTextCounts.get(key) || 0) + 1);
        }

        const unresolvedPending: ItemData[] = [];
        for (const pending of pendingItems) {
          if (serverIds.has(pending.id)) continue;
          const key = pending.text.toLowerCase();
          const serverCount = serverTextCounts.get(key) || 0;
          if (serverCount > 0) {
            serverTextCounts.set(key, serverCount - 1);
          } else {
            unresolvedPending.push(pending);
          }
        }

        return [...unresolvedPending, ...mapped];
      });
    } catch (e) {
      console.error("[List] Background refresh error:", e);
    }
  }, [jwtRef, listId, listType]);

  return { listName, setListName, items, setItems, loading, error, isShared, setIsShared, listType, setListType, fetchItems, refreshItems };
}
