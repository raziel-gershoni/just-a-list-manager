"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, Send, Share2, ChevronDown, ChevronRight, Trash2, Users, RefreshCw } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import AddItemInput from "@/components/AddItemInput";
import ItemRow from "@/components/ItemRow";
import SortableItem from "@/components/SortableItem";
import OfflineIndicator from "@/components/OfflineIndicator";
import ShareDialog from "@/components/ShareDialog";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";
import { useMutationQueue, ExecutorFactory } from "@/src/hooks/useMutationQueue";
import type { QueuedMutation } from "@/src/utils/mutation-queue";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropEvents } from "@dnd-kit/react";

interface ItemData {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  position: number;
  created_by: string | null;
  creator_name: string | null;
  edited_by: string | null;
  editor_name: string | null;
  _pending?: boolean;
}

function genMutId(): string {
  return `mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function lookupUserName(items: ItemData[], targetUserId: string | null): string | null {
  if (!targetUserId) return null;
  for (const item of items) {
    if (item.created_by === targetUserId && item.creator_name) return item.creator_name;
    if (item.edited_by === targetUserId && item.editor_name) return item.editor_name;
  }
  return null;
}

function ListContent() {
  const {
    isReady,
    supabaseClient,
    supabaseClientRef,
    userId,
    jwtRef,
    onFlushNeeded,
    onResubscribeNeeded,
    onRefreshNeeded,
  } = useTelegram();
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const listId = params.id as string;

  const [listName, setListName] = useState("");
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [undoAction, setUndoAction] = useState<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);

  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [reminderToast, setReminderToast] = useState<string | null>(null);

  const isDraggingRef = useRef(false);
  const previousItemsRef = useRef<ItemData[]>([]);

  // JWT getter for mutation queue (reads latest from ref)
  const getJwt = useCallback(() => jwtRef.current, [jwtRef]);

  const executorFactory: ExecutorFactory = useCallback(
    (mutation: QueuedMutation, getJwtParam: () => string) => {
      const { type, payload } = mutation;
      switch (type) {
        case "create":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(`/api/lists/${payload.listId}/items`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: payload.text,
                idempotencyKey: payload.idempotencyKey,
                position: payload.position,
              }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Create failed: ${res.status}`);
            const { items: created } = await res.json();
            return created?.[0]?.id as string | undefined;
          };
        case "toggle":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(`/api/lists/${payload.listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
          };
        case "delete":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(
              `/api/lists/${payload.listId}/items?itemId=${payload.itemId}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${jwt}` },
                keepalive: true,
              }
            );
            if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
          };
        case "edit":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(`/api/lists/${payload.listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: payload.itemId, text: payload.text }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
          };
        case "reorder":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(`/api/lists/${payload.listId}/items/reorder`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ orderedIds: payload.orderedIds }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
          };
        case "recycle":
          return async () => {
            const jwt = getJwtParam();
            const res = await fetch(`/api/lists/${payload.listId}/items`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text: payload.text, recycleId: payload.recycleId }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
          };
        default:
          return null;
      }
    },
    []
  );

  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory);

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
        const currentList = allLists.find((l: any) => l.id === listId);
        if (currentList) {
          setListName(currentList.name);
          setIsShared(currentList.is_shared ?? false);
        }
      }

      // Fetch items
      const res = await fetch(`/api/lists/${listId}/items`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const { items: fetchedItems } = await res.json();
        const mapped = (fetchedItems || []).map((item: any) => ({
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          users: undefined,
          editor: undefined,
        }));
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
      const mapped = (fetchedItems || []).map((item: any) => ({
        ...item,
        creator_name: item.users?.name ?? null,
        editor_name: item.editor?.name ?? null,
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

  const { resubscribe } = useRealtimeList(
    supabaseClient,
    supabaseClientRef,
    listId,
    (change) => {
      // Handle real-time item changes
      if (change.table === "items") {
        if (change.eventType === "INSERT") {
          setItems((prev) => {
            if (prev.find((i) => i.id === change.new.id)) return prev;
            const serverItem = {
              ...change.new,
              creator_name: lookupUserName(prev, change.new.created_by),
              editor_name: lookupUserName(prev, change.new.edited_by),
            } as ItemData;
            // Replace pending optimistic item if it matches this server item
            const pendingIndex = prev.findIndex(
              (i) => i._pending && i.text === change.new.text
            );
            if (pendingIndex !== -1) {
              const updated = [...prev];
              updated[pendingIndex] = serverItem;
              return updated;
            }
            return [...prev, serverItem];
          });
        } else if (change.eventType === "UPDATE") {
          setItems((prev) =>
            prev.map((i) => {
              if (i.id !== change.new.id) return i;
              const updates = change.new;
              let merged;
              // During drag, skip position-only updates to avoid fighting local reorder
              if (isDraggingRef.current) {
                const { position, ...rest } = updates;
                merged = { ...i, ...rest };
              } else {
                merged = { ...i, ...updates };
              }
              if (updates.edited_by && updates.edited_by !== i.edited_by) {
                merged.editor_name = lookupUserName(prev, updates.edited_by);
              }
              return merged;
            })
          );
        } else if (change.eventType === "DELETE") {
          setItems((prev) => prev.filter((i) => i.id !== change.old.id));
        }
      } else if (change.table === "lists") {
        if (change.eventType === "UPDATE") {
          if (change.new.deleted_at) {
            router.push("/");
          } else if (change.new.name) {
            setListName(change.new.name);
          }
        }
      }
    }
  );

  // Register orchestrator callbacks
  useEffect(() => {
    onFlushNeeded.current = flushQueue;
    onResubscribeNeeded.current = resubscribe;
    onRefreshNeeded.current = refreshItems;
    return () => {
      onFlushNeeded.current = null;
      onResubscribeNeeded.current = null;
      onRefreshNeeded.current = null;
    };
  }, [flushQueue, resubscribe, refreshItems, onFlushNeeded, onResubscribeNeeded, onRefreshNeeded]);

  useEffect(() => {
    if (isReady) fetchItems();
  }, [isReady, fetchItems]);

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
        position,
        created_by: userId,
        creator_name: null,
        edited_by: null,
        editor_name: null,
        _pending: true,
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
    [jwtRef, listId, addMutation, userId]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      const jwt = jwtRef.current;
      if (!jwt) return;

      // Check for duplicate
      const existing = items.find(
        (i) => !i.completed && !i.deleted_at && i.text.toLowerCase() === text.toLowerCase()
      );
      if (existing) {
        const tg = (window as any).Telegram?.WebApp;
        tg?.HapticFeedback?.notificationOccurred("warning");
        setDuplicateWarning(t("items.duplicateWarning"));
        setTimeout(() => setDuplicateWarning(null), 2500);
      }

      if (recycleId) {
        // Recycle: optimistic update
        setItems((prev) =>
          prev.map((i) =>
            i.id === recycleId
              ? { ...i, completed: false, completed_at: null, deleted_at: null }
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
    [jwtRef, listId, addMutation, addSingleItem, items, t]
  );

  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // Optimistic
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                completed,
                completed_at: completed ? new Date().toISOString() : null,
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
    [jwtRef, listId, addMutation]
  );

  const handleDelete = useCallback(
    async (itemId: string) => {
      const tg = (window as any).Telegram?.WebApp;
      tg?.HapticFeedback?.notificationOccurred("warning");

      const deletedItem = items.find((i) => i.id === itemId);
      // Optimistic removal
      setItems((prev) => prev.filter((i) => i.id !== itemId));

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
    [jwtRef, listId, items, addMutation, t]
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
    [jwtRef, listId, addMutation, userId]
  );

  const handleClearCompleted = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const tg = (window as any).Telegram?.WebApp;
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
  }, [jwtRef, listId, items, t]);

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
  }, [jwtRef, listId, t]);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    isDraggingRef.current = true;
    previousItemsRef.current = [...items];
    const tg = (window as any).Telegram?.WebApp;
    tg?.HapticFeedback?.impactOccurred("medium");
  }, [items]);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      if (event.canceled) {
        setItems(previousItemsRef.current);
        isDraggingRef.current = false;
        return;
      }

      const { source, target } = event.operation;
      if (!source || !target) {
        isDraggingRef.current = false;
        return;
      }

      const sourceId = source.id as string;
      const projectedIndex = (source as any).sortable?.index as number | undefined;

      // Compute new order from current active items
      const currentActive = items
        .filter((i) => !i.completed && !i.deleted_at)
        .sort((a, b) => b.position - a.position);

      const originalIndex = currentActive.findIndex((i) => i.id === sourceId);

      if (originalIndex === -1 || projectedIndex == null || originalIndex === projectedIndex) {
        isDraggingRef.current = false;
        return;
      }

      const reordered = [...currentActive];
      const [moved] = reordered.splice(originalIndex, 1);
      reordered.splice(projectedIndex, 0, moved);

      // Assign new positions (highest position = first item)
      const updatedIds: string[] = [];
      const positionMap = new Map<string, number>();
      reordered.forEach((item, index) => {
        const newPosition = reordered.length - index;
        positionMap.set(item.id, newPosition);
        updatedIds.push(item.id);
      });

      // Update items state with new positions
      setItems((prev) =>
        prev.map((item) => {
          const newPos = positionMap.get(item.id);
          if (newPos != null) return { ...item, position: newPos };
          return item;
        })
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "reorder",
        payload: { listId, orderedIds: updatedIds },
        execute: async () => {
          try {
            const jwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items/reorder`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ orderedIds: updatedIds }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
          } finally {
            isDraggingRef.current = false;
          }
        },
      });
    },
    [items, jwtRef, listId, addMutation]
  );

  const activeItems = items
    .filter((i) => !i.completed && !i.deleted_at)
    .sort((a, b) => b.position - a.position);

  const completedItems = items
    .filter((i) => i.completed && !i.deleted_at)
    .sort((a, b) => {
      const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bTime - aTime;
    });

  // Compute duplicate text set for active items
  const duplicateTexts = new Set<string>();
  const seenTexts = new Map<string, number>();
  for (const item of activeItems) {
    const key = item.text.toLowerCase();
    seenTexts.set(key, (seenTexts.get(key) || 0) + 1);
  }
  for (const [key, count] of seenTexts) {
    if (count > 1) duplicateTexts.add(key);
  }

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <div className="h-12 bg-tg-secondary-bg rounded-xl animate-pulse" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-12 bg-tg-secondary-bg rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4">
        <p className="text-tg-hint mb-4">{t('lists.loadError')}</p>
        <button
          onClick={fetchItems}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 p-4 pb-0">
        <button onClick={() => router.push("/")} className="p-1">
          <ArrowLeft className="w-5 h-5 text-tg-text rtl:scale-x-[-1]" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-tg-text truncate">{listName}</h1>
          {isShared && (
            <p className="text-xs text-tg-hint flex items-center gap-1">
              <Users className="w-3 h-3" />
              {t('lists.shared')}
            </p>
          )}
        </div>
        {isShared && (
          <button onClick={handleRemind} className="p-1">
            <Send className="w-5 h-5 text-tg-hint" />
          </button>
        )}
        <button onClick={() => setShowShare(true)} className="p-1">
          <Share2 className="w-5 h-5 text-tg-hint" />
        </button>
      </header>

      <OfflineIndicator />

      <AddItemInput listId={listId} onAddItem={handleAddItem} />

      {/* Item list */}
      <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        {/* Active items */}
        <DragDropProvider onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {activeItems.map((item, index) => (
            <SortableItem
              key={item.id}
              id={item.id}
              index={index}
              text={item.text}
              isPending={item._pending}
              isDuplicate={duplicateTexts.has(item.text.toLowerCase())}
              creatorName={isShared ? item.creator_name : null}
              isOwnItem={item.created_by === userId}
              editorName={isShared ? item.editor_name : null}
              isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={handleEditItem}
            />
          ))}
        </DragDropProvider>

        {/* Completed section */}
        {completedItems.length > 0 && (
          <>
            <button
              onClick={() => setShowCompleted((p) => !p)}
              className="flex items-center gap-2 w-full px-4 py-3 text-sm text-tg-hint"
            >
              {showCompleted ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />
              )}
              {t('items.completedSection', { count: completedItems.length })}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleClearCompleted();
                }}
                className="ms-auto text-tg-destructive text-xs flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                {t('items.clearCompleted')}
              </button>
            </button>
            {showCompleted &&
              completedItems.map((item) => (
                <ItemRow
                  key={item.id}
                  id={item.id}
                  text={item.text}
                  completed={true}
                  creatorName={isShared ? item.creator_name : null}
                  isOwnItem={item.created_by === userId}
                  editorName={isShared ? item.editor_name : null}
                  isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onEdit={handleEditItem}
                />
              ))}
          </>
        )}

        {activeItems.length === 0 && completedItems.length === 0 && (
          <div className="text-center text-tg-hint py-16">
            <p className="text-lg mb-1">{t('items.emptyTitle')}</p>
            <p className="text-sm">{t('items.emptyDescription')}</p>
          </div>
        )}
      </div>

      {/* Reminder toast */}
      {reminderToast && !undoAction && (
        <div className="fixed bottom-6 start-4 end-4 bg-tg-button text-tg-button-text rounded-xl py-3 px-4 z-30 shadow-lg">
          <span className="text-sm">{reminderToast}</span>
        </div>
      )}

      {/* Duplicate warning toast */}
      {duplicateWarning && !undoAction && !reminderToast && (
        <div className="fixed bottom-6 start-4 end-4 bg-amber-500 text-white rounded-xl py-3 px-4 z-30 shadow-lg">
          <span className="text-sm">{duplicateWarning}</span>
        </div>
      )}

      {/* Undo toast */}
      {undoAction && (
        <div className="fixed bottom-6 start-4 end-4 bg-foreground text-background rounded-xl py-3 px-4 flex items-center justify-between z-30 shadow-lg">
          <span className="text-sm">{undoAction.message}</span>
          <button
            onClick={undoAction.undo}
            className="text-sm font-semibold ms-4"
          >
            {t('common.undo')}
          </button>
        </div>
      )}

      <ShareDialog
        listId={listId}
        listName={listName}
        isOpen={showShare}
        onClose={() => setShowShare(false)}
      />
    </div>
  );
}

export default function ListPage() {
  return (
    <TelegramProvider>
      <ListContent />
    </TelegramProvider>
  );
}
