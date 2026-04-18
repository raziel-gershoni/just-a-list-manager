"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
import AddItemInput from "@/components/AddItemInput";
import SortableItem from "@/components/SortableItem";
import OfflineIndicator from "@/components/OfflineIndicator";
import ShareDialog from "@/components/ShareDialog";
import ReminderSheet from "@/components/ReminderSheet";
import ListHeader from "@/components/list/ListHeader";
import SkippedItemsSection from "@/components/list/SkippedItemsSection";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import ToastContainer from "@/components/list/ToastContainer";
import { useMutationQueue, type MutationErrorInfo } from "@/src/hooks/useMutationQueue";
import { useListData } from "@/src/hooks/useListData";
import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { useListDragDrop } from "@/src/hooks/useListDragDrop";
import { useListRealtime } from "@/src/hooks/useListRealtime";
import { useListDerivedData } from "@/src/hooks/useListDerivedData";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import { DragDropProvider } from "@dnd-kit/react";

const executorFactory = createExecutorFactory();

function ListContent() {
  const {
    isReady,
    supabaseClient,
    supabaseClientRef,
    userId,
    jwtRef,
    onFlushNeededRef,
    onResubscribeNeededRef,
    onRefreshNeededRef,
  } = useTelegram();
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const listId = params.id as string;

  const { listName, setListName, items, setItems, loading, error, isShared, remindersEnabled, setRemindersEnabled, fetchItems, refreshItems } =
    useListData(listId, jwtRef);
  const [showSettings, setShowSettings] = useState(false);

  const [showCompleted, setShowCompleted] = useState(() => {
    if (typeof window === "undefined") return true;
    const v = localStorage.getItem("panel_completed");
    return v === null ? true : v === "true";
  });
  const [showSkipped, setShowSkipped] = useState(() => {
    if (typeof window === "undefined") return false;
    const v = localStorage.getItem("panel_skipped");
    return v === null ? false : v === "true";
  });
  const [showShare, setShowShare] = useState(false);
  const [reminderItem, setReminderItem] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [reminderToast, setReminderToast] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // JWT getter for mutation queue (reads latest from ref)
  const getJwt = useCallback(() => jwtRef.current, [jwtRef]);

  const onMutationError = useCallback((info: MutationErrorInfo) => {
    if (info.dropped) {
      setErrorToast(t('items.syncError'));
      setTimeout(() => setErrorToast(null), 3000);
      // Remove the optimistic pending item when a create mutation is permanently dropped
      if (info.type === "create" && typeof info.payload?.tempId === "string") {
        setItems((prev) => prev.filter((i) => i.id !== info.payload.tempId));
      }
    }
  }, [t, setItems]);

  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory, onMutationError);

  const { handleDragStart, handleDragEnd, isDraggingRef } = useListDragDrop({
    items,
    setItems,
    addMutation,
    listId,
    jwtRef,
  });

  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleSetReminder, handleCancelReminder } =
    useItemHandlers({
      listId,
      jwtRef,
      userId,
      items,
      setItems,
      addMutation,
      setUndoAction,
      setDuplicateWarning,
      setReminderToast,
      t: t as (key: string, values?: Record<string, unknown>) => string,
    });

  const onListDeleted = useCallback(() => router.push("/"), [router]);

  const { resubscribe } = useListRealtime({
    supabaseClient,
    supabaseClientRef,
    listId,
    setItems,
    setListName,
    isDraggingRef,
    onListDeleted,
  });

  // Register orchestrator callbacks
  useEffect(() => {
    onFlushNeededRef.current = flushQueue;
    onResubscribeNeededRef.current = resubscribe;
    onRefreshNeededRef.current = refreshItems;
    return () => {
      onFlushNeededRef.current = null;
      onResubscribeNeededRef.current = null;
      onRefreshNeededRef.current = null;
    };
  }, [flushQueue, resubscribe, refreshItems, onFlushNeededRef, onResubscribeNeededRef, onRefreshNeededRef]);

  useEffect(() => {
    if (isReady) fetchItems();
  }, [isReady, fetchItems]);

  const { activeItems, skippedItems, completedItems, completedGroups, duplicateTexts } =
    useListDerivedData(items, t as (key: string) => string);

  if (loading) {
    return (
      <div className="px-5 pt-3 space-y-3">
        <div className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
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
      <ListHeader
        listName={listName}
        isShared={isShared}
        onRemind={handleRemind}
        onShare={() => setShowShare(true)}
        onSettings={() => setShowSettings(true)}
      />

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
              onSkip={item.my_remind_at ? undefined : handleSkip}
              onRemoveDuplicates={handleRemoveDuplicates}
              reminderAt={remindersEnabled ? item.my_remind_at : undefined}
              onReminderTap={remindersEnabled ? (id) => setReminderItem(id) : undefined}
            />
          ))}
        </DragDropProvider>

        <SkippedItemsSection
          skippedItems={skippedItems}
          showSkipped={showSkipped}
          setShowSkipped={setShowSkipped}
          duplicateTexts={duplicateTexts}
          isShared={isShared}
          userId={userId}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onEdit={handleEditItem}
          onSkip={handleSkip}
        />

        <CompletedItemsSection
          completedItems={completedItems}
          completedGroups={completedGroups}
          showCompleted={showCompleted}
          setShowCompleted={setShowCompleted}
          duplicateTexts={duplicateTexts}
          isShared={isShared}
          userId={userId}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onEdit={handleEditItem}
          onClearCompleted={handleClearCompleted}
        />

        {activeItems.length === 0 && skippedItems.length === 0 && completedItems.length === 0 && (
          <div className="text-center text-tg-hint py-16">
            <p className="text-lg mb-1">{t('items.emptyTitle')}</p>
            <p className="text-sm">{t('items.emptyDescription')}</p>
          </div>
        )}
      </div>

      <ToastContainer
        reminderToast={reminderToast}
        duplicateWarning={duplicateWarning}
        errorToast={errorToast}
        undoAction={undoAction}
      />

      <ShareDialog
        listId={listId}
        listName={listName}
        isOpen={showShare}
        onClose={() => setShowShare(false)}
      />

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter" onClick={() => setShowSettings(false)}>
          <div className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 sheet-enter" onClick={(e) => e.stopPropagation()}>
            <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
            <h2 className="text-lg font-semibold tracking-tight text-tg-text mb-4">{t('settings.listSettings')}</h2>
            <button
              onClick={async () => {
                const newValue = !remindersEnabled;
                setRemindersEnabled(newValue);
                const jwt = jwtRef.current;
                if (jwt) {
                  fetch("/api/lists", {
                    method: "PATCH",
                    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ id: listId, reminders_enabled: newValue }),
                  }).catch(() => {});
                }
              }}
              className="w-full flex items-center justify-between px-4 py-3.5 rounded-2xl active:bg-tg-secondary-bg"
            >
              <div>
                <span className="text-base text-tg-text">{t('settings.reminders')}</span>
                <p className="text-[13px] text-tg-hint">{t('settings.remindersDescription')}</p>
              </div>
              <div className={`w-11 h-6 rounded-full relative transition-colors ${remindersEnabled ? "bg-tg-button" : "bg-tg-secondary-bg border border-border"}`}>
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${remindersEnabled ? "start-[22px]" : "start-0.5"}`} />
              </div>
            </button>
            <button
              onClick={() => setShowSettings(false)}
              className="w-full mt-4 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {reminderItem && (() => {
        const item = items.find((i) => i.id === reminderItem);
        if (!item) return null;
        return (
          <ReminderSheet
            itemId={item.id}
            itemText={item.text}
            listId={listId}
            isShared={isShared}
            isOpen={true}
            onClose={() => setReminderItem(null)}
            onSetReminder={handleSetReminder}
            onCancelReminder={handleCancelReminder}
            existingReminder={
              item.my_reminder_id
                ? { id: item.my_reminder_id, remind_at: item.my_remind_at!, is_shared: item.my_reminder_shared ?? false, recurrence: item.my_reminder_recurrence ?? undefined }
                : null
            }
          />
        );
      })()}
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
