"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Globe, Check, RefreshCw, X, Smartphone, LogOut } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import ListCard from "@/components/ListCard";
import EmptyState from "@/components/EmptyState";
import OfflineIndicator from "@/components/OfflineIndicator";
import { getTelegramWebApp } from "@/src/types/telegram";
import type { SupportedLocale } from "@/src/lib/i18n";

interface ListData {
  id: string;
  name: string;
  active_count: number;
  completed_count: number;
  is_shared: boolean;
  role: "owner" | "view" | "edit";
}

function HomeContent() {
  const { isReady, locale, setLanguage, jwtRef, onRefreshNeededRef, homeScreenStatus, addToHomeScreen } = useTelegram();
  const t = useTranslations();
  const router = useRouter();
  const [lists, setLists] = useState<ListData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newListType, setNewListType] = useState<"regular" | "reminders" | "grocery">("regular");
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

  const [showLanguage, setShowLanguage] = useState(false);
  const [homeScreenDismissed, setHomeScreenDismissed] = useState<boolean | null>(null);
  const [isWebApp, setIsWebApp] = useState(false);

  // Read localStorage in effect to avoid SSR hydration mismatch
  useEffect(() => {
    try {
      setHomeScreenDismissed(localStorage.getItem("homescreen_banner_dismissed") === "true");
    } catch {
      setHomeScreenDismissed(false);
    }
    // Detect web app mode (no Telegram Mini App — script exists but initData is empty)
    const tg = getTelegramWebApp();
    setIsWebApp(!tg || !tg.initData);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("web_auth_token");
    router.push("/login");
  }, [router]);

  // Track the rename target ID separately so it persists through sheet open
  const renameTargetRef = useRef<string>("");

  const fetchLists = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      setError(false);
      const res = await fetch("/api/lists", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const data = await res.json();
        setLists(data);

        // Auto-open single list — only on first visit to avoid back-navigation loop
        if (data.length === 1) {
          const autoOpened = sessionStorage.getItem("autoOpenedSingleList");
          if (!autoOpened) {
            sessionStorage.setItem("autoOpenedSingleList", "true");
            router.push(`/list/${data[0].id}`);
            return;
          }
        } else {
          // Clear flag when list count changes so auto-open works again
          sessionStorage.removeItem("autoOpenedSingleList");
        }
      } else {
        setError(true);
      }
    } catch (e) {
      console.error("[Home] Fetch lists error:", e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [jwtRef, router]);

  useEffect(() => {
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);

  // Register with orchestrator for reconnect refresh
  useEffect(() => {
    onRefreshNeededRef.current = fetchLists;
    return () => {
      onRefreshNeededRef.current = null;
    };
  }, [fetchLists, onRefreshNeededRef]);

  const createList = async () => {
    const jwt = jwtRef.current;
    if (!newListName.trim() || !jwt) return;
    setCreating(true);
    try {
      const res = await fetch("/api/lists", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newListName.trim(), type: newListType }),
      });
      if (res.ok) {
        const list = await res.json();
        setNewListName("");
        setNewListType("regular");
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
    const jwt = jwtRef.current;
    if (!renameValue.trim() || !jwt || !renameTargetRef.current) return;
    setRenaming(true);
    try {
      const res = await fetch("/api/lists", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt}`,
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
  }, [renameValue, jwtRef]);

  const handleDeleteList = useCallback((listToDelete: ListData) => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const tg = getTelegramWebApp();

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
          const currentJwt = jwtRef.current;
          fetch("/api/lists", {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
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
        headers: { Authorization: `Bearer ${jwt}` },
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
  }, [jwtRef, t]);

  if (loading) {
    return (
      <div className="px-5 pt-3 space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[72px] bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
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
          onClick={fetchLists}
          className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (lists.length === 0) {
    return (
      <>
        <div className="absolute top-4 end-4 z-10 flex items-center gap-1">
          <button
            onClick={() => setShowLanguage(true)}
            className="p-2.5 rounded-full text-tg-hint active:bg-tg-secondary-bg active:scale-95"
          >
            <Globe className="w-5 h-5" />
          </button>
          {isWebApp && (
            <button
              onClick={handleLogout}
              className="p-2.5 rounded-full text-tg-hint active:bg-tg-secondary-bg active:scale-95"
              title={t("common.logout")}
            >
              <LogOut className="w-5 h-5" />
            </button>
          )}
        </div>
        <EmptyState onCreateList={() => setShowCreate(true)} />
        {showCreate && (
          <CreateListSheet
            value={newListName}
            onChange={setNewListName}
            listType={newListType}
            onTypeChange={setNewListType}
            onSubmit={createList}
            onClose={() => setShowCreate(false)}
            creating={creating}
          />
        )}
        {showLanguage && (
          <LanguageSheet
            currentLocale={locale}
            onSelect={async (lang) => {
              await setLanguage(lang);
              setShowLanguage(false);
            }}
            onClose={() => setShowLanguage(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="px-5 py-5 pb-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-tg-text">{t('lists.title')}</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowLanguage(true)}
            className="p-2.5 rounded-full text-tg-hint active:bg-tg-secondary-bg active:scale-95"
          >
            <Globe className="w-5 h-5" />
          </button>
          {isWebApp && (
            <button
              onClick={handleLogout}
              className="p-2.5 rounded-full text-tg-hint active:bg-tg-secondary-bg active:scale-95"
              title={t("common.logout")}
            >
              <LogOut className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      <OfflineIndicator />

      {/* Home screen shortcut banner */}
      {homeScreenDismissed === false &&
        homeScreenStatus !== null &&
        homeScreenStatus !== "added" &&
        homeScreenStatus !== "unsupported" && (
          <div className="mx-5 mt-3 flex items-center gap-3 rounded-2xl bg-tg-secondary-bg px-5 py-4 border border-border/30">
            <Smartphone className="w-5 h-5 text-tg-button shrink-0" />
            <span className="flex-1 text-sm text-tg-text">
              {t('lists.addToHomeScreen')}
            </span>
            <button
              onClick={addToHomeScreen}
              className="px-3 py-1.5 rounded-lg bg-tg-button text-tg-button-text text-sm font-medium shrink-0"
            >
              {t('lists.addToHomeScreenAction')}
            </button>
            <button
              onClick={() => {
                setHomeScreenDismissed(true);
                try {
                  localStorage.setItem("homescreen_banner_dismissed", "true");
                } catch {}
              }}
              aria-label={t('common.close')}
              className="p-1 text-tg-hint shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

      <div className="flex-1 px-5 pt-3 pb-24 space-y-3">
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
        className="fixed bottom-8 end-6 w-14 h-14 rounded-full bg-tg-button text-tg-button-text shadow-xl shadow-tg-button/25 flex items-center justify-center active:scale-90 transition-all duration-200 z-20"
      >
        <Plus className="w-6 h-6" />
      </button>

      {showCreate && (
        <CreateListSheet
          value={newListName}
          onChange={setNewListName}
          listType={newListType}
          onTypeChange={setNewListType}
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

      {/* Language sheet */}
      {showLanguage && (
        <LanguageSheet
          currentLocale={locale}
          onSelect={async (lang) => {
            await setLanguage(lang);
            setShowLanguage(false);
          }}
          onClose={() => setShowLanguage(false)}
        />
      )}

      {/* Undo toast */}
      {undoAction && (
        <div className="fixed bottom-8 start-5 end-5 bg-foreground text-background rounded-2xl py-3.5 px-5 flex items-center justify-between z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
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
  listType,
  onTypeChange,
  onSubmit,
  onClose,
  creating,
}: {
  value: string;
  onChange: (v: string) => void;
  listType: "regular" | "reminders" | "grocery";
  onTypeChange: (t: "regular" | "reminders" | "grocery") => void;
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        <h2 className="text-lg font-semibold tracking-tight text-tg-text mb-4">
          {t('lists.newList')}
        </h2>
        {/* Type selector */}
        <div className="flex bg-tg-secondary-bg rounded-2xl p-1 mb-4">
          <button
            onClick={() => onTypeChange("regular")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              listType === "regular" ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint"
            }`}
          >
            {t('lists.typeRegular')}
          </button>
          <button
            onClick={() => onTypeChange("grocery")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              listType === "grocery" ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint"
            }`}
          >
            {t('lists.typeGrocery')}
          </button>
          <button
            onClick={() => onTypeChange("reminders")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              listType === "reminders" ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint"
            }`}
          >
            {t('lists.typeReminders')}
          </button>
        </div>
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
          className="w-full px-4 py-3 rounded-2xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint/70 outline-none text-base mb-4 focus:ring-2 focus:ring-tg-button/20"
        />
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || creating}
            className="flex-1 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium disabled:opacity-40 active:scale-[0.98]"
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        <h2 className="text-lg font-semibold tracking-tight text-tg-text mb-4">
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
          className="w-full px-4 py-3 rounded-2xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint/70 outline-none text-base mb-4 focus:ring-2 focus:ring-tg-button/20"
        />
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || renaming}
            className="flex-1 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium disabled:opacity-40 active:scale-[0.98]"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

const LANGUAGE_OPTIONS: { value: SupportedLocale; labelKey: string }[] = [
  { value: "en", labelKey: "settings.english" },
  { value: "he", labelKey: "settings.hebrew" },
  { value: "ru", labelKey: "settings.russian" },
];

function LanguageSheet({
  currentLocale,
  onSelect,
  onClose,
}: {
  currentLocale: SupportedLocale;
  onSelect: (lang: SupportedLocale) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={onClose}>
      <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter" onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        <h2 className="text-lg font-semibold tracking-tight text-tg-text mb-4">
          {t("settings.language")}
        </h2>
        <div className="space-y-1">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onSelect(opt.value)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-2xl text-tg-text active:bg-tg-secondary-bg transition-colors"
            >
              <span className="text-base">{t(opt.labelKey)}</span>
              {currentLocale === opt.value && (
                <Check className="w-5 h-5 text-tg-button" />
              )}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="w-full mt-4 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
        >
          {t("common.close")}
        </button>
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
