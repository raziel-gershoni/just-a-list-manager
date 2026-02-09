"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, Share2, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import AddItemInput from "@/components/AddItemInput";
import ItemRow from "@/components/ItemRow";
import OfflineIndicator from "@/components/OfflineIndicator";
import ShareDialog from "@/components/ShareDialog";
import { useRealtimeList } from "@/src/hooks/useRealtimeList";
import { useMutationQueue } from "@/src/hooks/useMutationQueue";

interface ItemData {
  id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  position: number;
  created_by: string | null;
  _pending?: boolean;
}

function ListContent() {
  const { initData, isReady, supabaseClient } = useTelegram();
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const listId = params.id as string;

  const [listName, setListName] = useState("");
  const [items, setItems] = useState<ItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompleted, setShowCompleted] = useState(true);
  const [showShare, setShowShare] = useState(false);
  const [undoAction, setUndoAction] = useState<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);

  const { connectionStatus } = useRealtimeList(
    supabaseClient,
    listId,
    (change) => {
      // Handle real-time item changes
      if (change.table === "items") {
        if (change.eventType === "INSERT") {
          setItems((prev) => {
            if (prev.find((i) => i.id === change.new.id)) return prev;
            return [...prev, change.new as ItemData];
          });
        } else if (change.eventType === "UPDATE") {
          setItems((prev) =>
            prev.map((i) =>
              i.id === change.new.id ? { ...i, ...change.new } : i
            )
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

  const { addMutation } = useMutationQueue(listId);

  const fetchItems = useCallback(async () => {
    if (!initData) return;
    try {
      // Fetch list info
      const listsRes = await fetch("/api/lists", {
        headers: { "x-telegram-init-data": initData },
      });
      if (listsRes.ok) {
        const allLists = await listsRes.json();
        const currentList = allLists.find((l: any) => l.id === listId);
        if (currentList) setListName(currentList.name);
      }

      // Fetch items
      const res = await fetch(`/api/lists/${listId}/items`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (res.ok) {
        const { items: fetchedItems } = await res.json();
        setItems(fetchedItems || []);
      }
    } catch (e) {
      console.error("[List] Fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [initData, listId]);

  useEffect(() => {
    if (isReady) fetchItems();
  }, [isReady, fetchItems]);

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      if (!initData) return;

      if (recycleId) {
        // Recycle: optimistic update
        setItems((prev) =>
          prev.map((i) =>
            i.id === recycleId
              ? { ...i, completed: false, completed_at: null, deleted_at: null }
              : i
          )
        );

        addMutation({
          type: "recycle",
          payload: { listId, recycleId },
          execute: async () => {
            await fetch(`/api/lists/${listId}/items`, {
              method: "POST",
              headers: {
                "x-telegram-init-data": initData!,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text, recycleId }),
            });
          },
        });
      } else {
        // Create new: optimistic
        const tempId = `temp-${Date.now()}-${Math.random()}`;
        const newItem: ItemData = {
          id: tempId,
          text,
          completed: false,
          completed_at: null,
          deleted_at: null,
          position: Date.now(),
          created_by: null,
          _pending: true,
        };
        setItems((prev) => [newItem, ...prev]);

        addMutation({
          type: "create",
          payload: { listId, text },
          execute: async () => {
            const res = await fetch(`/api/lists/${listId}/items`, {
              method: "POST",
              headers: {
                "x-telegram-init-data": initData!,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text }),
            });
            if (res.ok) {
              const { items: created } = await res.json();
              if (created?.[0]) {
                setItems((prev) =>
                  prev.map((i) =>
                    i.id === tempId ? { ...created[0], _pending: false } : i
                  )
                );
              }
            }
          },
        });
      }
    },
    [initData, listId, addMutation]
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

      addMutation({
        type: "toggle",
        payload: { listId, itemId, completed },
        execute: async () => {
          await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              "x-telegram-init-data": initData!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, completed }),
          });
        },
      });
    },
    [initData, listId, addMutation]
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
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                "x-telegram-init-data": initData!,
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

      addMutation({
        type: "delete",
        payload: { listId, itemId },
        execute: async () => {
          await fetch(
            `/api/lists/${listId}/items?itemId=${itemId}`,
            {
              method: "DELETE",
              headers: { "x-telegram-init-data": initData! },
            }
          );
        },
      });
    },
    [initData, listId, items, addMutation]
  );

  const handleClearCompleted = useCallback(async () => {
    if (!initData) return;
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
        // Restore on server — undo by patching deleted_at to null for each
        for (const item of completedItems) {
          fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              "x-telegram-init-data": initData!,
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
      headers: { "x-telegram-init-data": initData },
    });
  }, [initData, listId, items]);

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

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="flex items-center gap-3 p-4 pb-0">
        <button onClick={() => router.push("/")} className="p-1">
          <ArrowLeft className="w-5 h-5 text-tg-text" />
        </button>
        <h1 className="flex-1 text-lg font-bold text-tg-text truncate">
          {listName}
        </h1>
        <button onClick={() => setShowShare(true)} className="p-1">
          <Share2 className="w-5 h-5 text-tg-hint" />
        </button>
      </header>

      <OfflineIndicator status={connectionStatus} />

      <AddItemInput listId={listId} onAddItem={handleAddItem} />

      {/* Item list */}
      <div className="flex-1">
        {/* Active items */}
        {activeItems.map((item) => (
          <ItemRow
            key={item.id}
            id={item.id}
            text={item.text}
            completed={false}
            isPending={item._pending}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        ))}

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
                <ChevronRight className="w-4 h-4" />
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
                  onToggle={handleToggle}
                  onDelete={handleDelete}
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
