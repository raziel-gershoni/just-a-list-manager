"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import ListCard from "@/components/ListCard";
import EmptyState from "@/components/EmptyState";

interface ListData {
  id: string;
  name: string;
  active_count: number;
  completed_count: number;
  is_shared: boolean;
  role: "owner" | "view" | "edit";
}

function HomeContent() {
  const { initData, isReady } = useTelegram();
  const t = useTranslations();
  const router = useRouter();
  const [lists, setLists] = useState<ListData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [creating, setCreating] = useState(false);

  // List management state
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [undoAction, setUndoAction] = useState<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);

  // Track the rename target ID separately so it persists through sheet open
  const renameTargetRef = useRef<string>("");

  const fetchLists = useCallback(async () => {
    if (!initData) return;
    try {
      const res = await fetch("/api/lists", {
        headers: { "x-telegram-init-data": initData },
      });
      if (res.ok) {
        const data = await res.json();
        setLists(data);

        // Auto-open single list (AC 4) — only on first visit to avoid back-navigation loop
        if (data.length === 1) {
          const autoOpened = sessionStorage.getItem("autoOpenedSingleList");
          if (!autoOpened) {
            sessionStorage.setItem("autoOpenedSingleList", "true");
            router.push(`/list/${data[0].id}`);
            return;
          }
        }
      }
    } catch (e) {
      console.error("[Home] Fetch lists error:", e);
    } finally {
      setLoading(false);
    }
  }, [initData, router]);

  useEffect(() => {
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);

  const createList = async () => {
    if (!newListName.trim() || !initData) return;
    setCreating(true);
    try {
      const res = await fetch("/api/lists", {
        method: "POST",
        headers: {
          "x-telegram-init-data": initData,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newListName.trim() }),
      });
      if (res.ok) {
        const list = await res.json();
        setNewListName("");
        setShowCreate(false);
        router.push(`/list/${list.id}`);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create list");
      }
    } catch (e) {
      console.error("[Home] Create list error:", e);
    } finally {
      setCreating(false);
    }
  };

  const handleEditList = useCallback((list: ListData) => {
    renameTargetRef.current = list.id;
    setRenameValue(list.name);
    setShowRename(true);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameValue.trim() || !initData || !renameTargetRef.current) return;
    setRenaming(true);
    try {
      const res = await fetch("/api/lists", {
        method: "PATCH",
        headers: {
          "x-telegram-init-data": initData!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: renameTargetRef.current, name: renameValue.trim() }),
      });
      if (res.ok) {
        setLists((prev) =>
          prev.map((l) =>
            l.id === renameTargetRef.current ? { ...l, name: renameValue.trim() } : l
          )
        );
        setShowRename(false);
      }
    } catch (e) {
      console.error("[Home] Rename error:", e);
    } finally {
      setRenaming(false);
    }
  }, [renameValue, initData]);

  const handleDeleteList = useCallback((listToDelete: ListData) => {
    if (!initData) return;
    const tg = (window as any).Telegram?.WebApp;

    const doDelete = () => {
      tg?.HapticFeedback?.notificationOccurred("warning");

      // Optimistic removal
      setLists((prev) => prev.filter((l) => l.id !== listToDelete.id));

      // Clear any existing undo
      setUndoAction((prev) => {
        if (prev) clearTimeout(prev.timeout);
        return null;
      });

      const timeout = setTimeout(() => setUndoAction(null), 4000);

      setUndoAction({
        message: t('lists.deleted'),
        undo: () => {
          clearTimeout(timeout);
          setUndoAction(null);
          // Restore optimistically
          setLists((prev) => [...prev, listToDelete]);
          // Restore on server
          fetch("/api/lists", {
            method: "PATCH",
            headers: {
              "x-telegram-init-data": initData!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: listToDelete.id, restore: true }),
          });
        },
        timeout,
      });

      // Server delete
      fetch(`/api/lists?id=${listToDelete.id}`, {
        method: "DELETE",
        headers: { "x-telegram-init-data": initData! },
      });
    };

    // Use Telegram native confirm if available, fallback to window.confirm
    if (tg?.showConfirm) {
      tg.showConfirm(t('lists.deleteConfirm'), (confirmed: boolean) => {
        if (confirmed) doDelete();
      });
    } else {
      if (window.confirm(t('lists.deleteConfirm'))) {
        doDelete();
      }
    }
  }, [initData, t]);

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 bg-tg-secondary-bg rounded-xl animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (lists.length === 0) {
    return (
      <>
        <EmptyState onCreateList={() => setShowCreate(true)} />
        {showCreate && (
          <CreateListSheet
            value={newListName}
            onChange={setNewListName}
            onSubmit={createList}
            onClose={() => setShowCreate(false)}
            creating={creating}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="p-4 pb-2">
        <h1 className="text-xl font-bold text-tg-text">{t('lists.title')}</h1>
      </header>

      <div className="flex-1 p-4 pt-2 space-y-2">
        {lists.map((list) => (
          <ListCard
            key={list.id}
            id={list.id}
            name={list.name}
            activeCount={list.active_count}
            completedCount={list.completed_count}
            isShared={list.is_shared}
            role={list.role}
            onClick={() => router.push(`/list/${list.id}`)}
            onEdit={list.role === "owner" ? () => handleEditList(list) : undefined}
            onDelete={list.role === "owner" ? () => handleDeleteList(list) : undefined}
          />
        ))}
      </div>

      {/* FAB to create new list */}
      <button
        onClick={() => setShowCreate(true)}
        className="fixed bottom-6 end-6 w-14 h-14 rounded-full bg-tg-button text-tg-button-text shadow-lg flex items-center justify-center active:opacity-80 transition-opacity z-20"
      >
        <Plus className="w-6 h-6" />
      </button>

      {showCreate && (
        <CreateListSheet
          value={newListName}
          onChange={setNewListName}
          onSubmit={createList}
          onClose={() => setShowCreate(false)}
          creating={creating}
        />
      )}

      {/* Rename sheet */}
      {showRename && (
        <RenameListSheet
          value={renameValue}
          onChange={setRenameValue}
          onSubmit={handleRenameSubmit}
          onClose={() => setShowRename(false)}
          renaming={renaming}
        />
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
    </div>
  );
}

function CreateListSheet({
  value,
  onChange,
  onSubmit,
  onClose,
  creating,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-tg-text mb-4">
          {t('lists.newList')}
        </h2>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder={t('lists.newListPlaceholder')}
          autoFocus
          maxLength={100}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint outline-none text-base mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-tg-secondary-bg text-tg-text font-medium"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || creating}
            className="flex-1 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium disabled:opacity-40"
          >
            {creating ? t('common.creating') : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameListSheet({
  value,
  onChange,
  onSubmit,
  onClose,
  renaming,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  renaming: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-tg-text mb-4">
          {t('lists.rename')}
        </h2>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder={t('lists.newListPlaceholder')}
          autoFocus
          maxLength={100}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint outline-none text-base mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-tg-secondary-bg text-tg-text font-medium"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || renaming}
            className="flex-1 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium disabled:opacity-40"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <TelegramProvider>
      <HomeContent />
    </TelegramProvider>
  );
}
