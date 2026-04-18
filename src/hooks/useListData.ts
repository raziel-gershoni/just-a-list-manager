"use client";

import { useState, useCallback } from "react";
import type { ItemData } from "@/src/types";

export function useListData(listId: string, jwtRef: React.RefObject<string | null>) {
  const [listName, setListName] = useState("");
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [remindersEnabled, setRemindersEnabled] = useState(true);

  const fetchItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      setError(false);
      // Fetch list info
      const listsRes = await fetch("/api/lists", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (listsRes.ok) {
        const allLists = await listsRes.json();
        const currentList = allLists.find((l: { id: string; name: string; is_shared?: boolean; reminders_enabled?: boolean }) => l.id === listId);
        if (currentList) {
          setListName(currentList.name);
          setIsShared(currentList.is_shared ?? false);
          setRemindersEnabled(currentList.reminders_enabled ?? true);
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
        // Fetch active reminders for all items in this list
        const remindersRes = await fetch(`/api/lists/${listId}/reminders`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        const remindersByItem = new Map<string, { id: string; remind_at: string; is_shared: boolean; recurrence?: string }>();
        if (remindersRes.ok) {
          const { reminders } = await remindersRes.json();
          for (const r of reminders || []) {
            // Keep the earliest reminder per item
            if (!remindersByItem.has(r.item_id) || r.remind_at < remindersByItem.get(r.item_id)!.remind_at) {
              remindersByItem.set(r.item_id, r);
            }
          }
        }

        const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string; skipped_at?: string | null }) => {
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
      const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string } }) => ({
        ...item,
        creator_name: item.users?.name ?? null,
        editor_name: item.editor?.name ?? null,
        _pending: false,
        users: undefined,
        editor: undefined,
      }));
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
  }, [jwtRef, listId]);

  return { listName, setListName, items, setItems, loading, error, isShared, setIsShared, remindersEnabled, setRemindersEnabled, fetchItems, refreshItems };
}
