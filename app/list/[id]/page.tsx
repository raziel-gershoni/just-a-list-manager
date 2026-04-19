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

  const { listName, setListName, items, setItems, loading, error, isShared, listType, setListType, fetchItems, refreshItems } =
    useListData(listId, jwtRef);
  const [showSettings, setShowSettings] = useState(false);
  const isReminders = listType === "reminders";

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

  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRemoveDuplicates, handleClearCompleted, handleRemind, handleSetReminder, handleUpdateReminder, handleCancelReminder } =
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
      listType,
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

      <AddItemInput
        listId={listId}
        listType={listType}
        onAddItem={(text, recycleId) => {
          handleAddItem(text, recycleId);
          // Auto-open ReminderSheet for newly added items in reminders lists
          if (isReminders) {
            // Find the pending item that was just added (it's prepended to items)
            setTimeout(() => {
              setItems((prev) => {
                const newItem = prev.find((i) => i._pending && i.text === text);
                if (newItem) setReminderItem(newItem.id);
                return prev;
              });
            }, 0);
          }
        }}
      />

      {/* Item list */}
      <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        {isReminders ? (
          /* Reminders list: items sorted by remind_at with date group headers */
          <ReminderItemsList
            items={activeItems}
            completedItems={completedItems}
            showCompleted={showCompleted}
            setShowCompleted={setShowCompleted}
            isShared={isShared}
            userId={userId}
            duplicateTexts={duplicateTexts}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onEdit={handleEditItem}
            onReminderTap={(id) => setReminderItem(id)}
            onSetReminder={handleSetReminder}
            onClearCompleted={handleClearCompleted}
            t={t}
          />
        ) : (
          <>
            {/* Regular list: position-ordered with drag-to-reorder */}
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
                  onSkip={listType === "grocery" ? handleSkip : undefined}
                  onRemoveDuplicates={handleRemoveDuplicates}
                />
              ))}
            </DragDropProvider>

            {listType === "grocery" && (
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
            )}

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
          </>
        )}

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
            <div className="flex bg-tg-secondary-bg rounded-2xl p-1 mb-4">
              {(["regular", "grocery", "reminders"] as const).map((tp) => (
                <button
                  key={tp}
                  onClick={() => {
                    setListType(tp);
                    const jwt = jwtRef.current;
                    if (jwt) {
                      fetch("/api/lists", {
                        method: "PATCH",
                        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ id: listId, type: tp }),
                      }).catch(() => {});
                    }
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                    listType === tp ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint"
                  }`}
                >
                  {tp === "regular" ? t('lists.typeRegular') : tp === "grocery" ? t('lists.typeGrocery') : t('lists.typeReminders')}
                </button>
              ))}
            </div>
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
            onUpdateReminder={handleUpdateReminder}
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupByDate(items: ItemData[], t: any) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);

  const groups: { label: string; items: ItemData[] }[] = [];
  const sorted = [...items].sort((a, b) => {
    const ta = a.my_remind_at ? new Date(a.my_remind_at).getTime() : Infinity;
    const tb = b.my_remind_at ? new Date(b.my_remind_at).getTime() : Infinity;
    return ta - tb;
  });

  const buckets: Record<string, ItemData[]> = {};
  for (const item of sorted) {
    const d = item.my_remind_at ? new Date(item.my_remind_at) : null;
    let key: string;
    if (!d) key = t('items.laterGroup');
    else if (d.getTime() < now.getTime()) key = t('items.overdue');
    else if (d < tomorrow) key = t('items.todayGroup');
    else if (d < new Date(tomorrow.getTime() + 86400000)) key = t('items.tomorrowGroup');
    else if (d < nextWeek) key = t('items.thisWeekGroup');
    else key = t('items.laterGroup');

    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(item);
  }

  const order = [t('items.overdue'), t('items.todayGroup'), t('items.tomorrowGroup'), t('items.thisWeekGroup'), t('items.laterGroup')];
  for (const label of order) {
    if (buckets[label]?.length) groups.push({ label, items: buckets[label] });
  }
  return groups;
}

import ItemRow from "@/components/ItemRow";
import type { ItemData } from "@/src/types";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";

function ReminderItemsList({
  items,
  completedItems,
  showCompleted,
  setShowCompleted,
  isShared,
  userId,
  duplicateTexts,
  onToggle,
  onDelete,
  onEdit,
  onReminderTap,
  onSetReminder,
  onClearCompleted,
  t,
}: {
  items: ItemData[];
  completedItems: ItemData[];
  showCompleted: boolean;
  setShowCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  isShared: boolean;
  userId: string | null;
  duplicateTexts: Set<string>;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, newText: string) => void;
  onReminderTap: (id: string) => void;
  onSetReminder: (itemId: string, remindAt: string, isShared: boolean, recurrence?: string) => void;
  onClearCompleted: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const groups = groupByDate(items, t);
  const overdueLabel = t('items.overdue');

  const snooze1h = (item: ItemData) => {
    const remindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    onSetReminder(item.id, remindAt, item.my_reminder_shared ?? false, item.my_reminder_recurrence ?? undefined);
  };
  const snoozeTomorrow = (item: ItemData) => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    onSetReminder(item.id, d.toISOString(), item.my_reminder_shared ?? false, item.my_reminder_recurrence ?? undefined);
  };

  return (
    <>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-5 pt-4 pb-1.5 text-[11px] text-tg-hint/70 font-semibold tracking-widest uppercase bg-tg-secondary-bg/80 backdrop-blur-md">
            {group.label}
          </div>
          {group.items.map((item) => (
            <div key={item.id}>
              <ItemRow
                id={item.id}
                text={item.text}
                completed={false}
                isPending={item._pending}
                creatorName={isShared ? item.creator_name : null}
                isOwnItem={item.created_by === userId}
                editorName={isShared ? item.editor_name : null}
                isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
                onToggle={onToggle}
                onDelete={onDelete}
                onEdit={onEdit}
                reminderAt={item.my_remind_at}
                onReminderTap={onReminderTap}
              />
              {group.label === overdueLabel && (
                <div className="flex gap-2 px-5 pb-2">
                  <button
                    onClick={() => snooze1h(item)}
                    className="px-3 py-1 rounded-full text-[12px] font-medium bg-tg-secondary-bg text-tg-text active:scale-95"
                  >
                    +1h
                  </button>
                  <button
                    onClick={() => snoozeTomorrow(item)}
                    className="px-3 py-1 rounded-full text-[12px] font-medium bg-tg-secondary-bg text-tg-text active:scale-95"
                  >
                    {t('items.tomorrowMorning')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {items.length === 0 && completedItems.length === 0 && (
        <div className="text-center text-tg-hint py-16">
          <p className="text-lg mb-1">{t('items.emptyTitle')}</p>
          <p className="text-sm">{t('items.emptyDescription')}</p>
        </div>
      )}

      {/* Completed section for reminders */}
      {completedItems.length > 0 && (
        <>
          <button
            onClick={() => setShowCompleted((p) => { localStorage.setItem("panel_completed", String(!p)); return !p; })}
            className="sticky top-0 z-20 flex items-center gap-2.5 w-full px-5 py-3.5 text-[13px] font-medium tracking-wide text-tg-hint bg-tg-secondary-bg/80 backdrop-blur-md border-t border-separator"
          >
            {showCompleted ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4 rtl:scale-x-[-1]" />}
            {t('items.completedSection', { count: completedItems.length })}
            <button
              onClick={(e) => { e.stopPropagation(); onClearCompleted(); }}
              className="ms-auto text-tg-destructive/80 text-[12px] font-medium tracking-wide flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              {t('items.clearCompleted')}
            </button>
          </button>
          {showCompleted && completedItems.map((item) => (
            <ItemRow
              key={item.id}
              id={item.id}
              text={item.text}
              completed={true}
              creatorName={isShared ? item.creator_name : null}
              isOwnItem={item.created_by === userId}
              editorName={isShared ? item.editor_name : null}
              isOwnEdit={item.edited_by === userId || item.edited_by === item.created_by}
              onToggle={onToggle}
              onDelete={onDelete}
              onEdit={onEdit}
              reminderAt={item.my_remind_at}
            />
          ))}
        </>
      )}
    </>
  );
}

export default function ListPage() {
  return (
    <TelegramProvider>
      <ListContent />
    </TelegramProvider>
  );
}
