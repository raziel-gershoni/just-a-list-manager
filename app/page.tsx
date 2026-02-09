"use client";

import { useEffect, useState, useCallback } from "react";
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
  role: string;
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

  const fetchLists = useCallback(async () => {
    if (!initData) return;
    try {
      const res = await fetch("/api/lists", {
        headers: { "x-telegram-init-data": initData },
      });
      if (res.ok) {
        const data = await res.json();
        setLists(data);

        // Auto-open single list (AC 4)
        if (data.length === 1) {
          router.push(`/list/${data[0].id}`);
          return;
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
            role={list.role}
            onClick={() => router.push(`/list/${list.id}`)}
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="bg-tg-bg w-full max-w-lg rounded-t-2xl p-6">
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

export default function HomePage() {
  return (
    <TelegramProvider>
      <HomeContent />
    </TelegramProvider>
  );
}
