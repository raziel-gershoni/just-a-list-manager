"use client";

import { useSortable } from "@dnd-kit/react/sortable";
import { PointerSensor, PointerActivationConstraints } from "@dnd-kit/dom";
import ItemRow from "./ItemRow";

const longPressSensor = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Delay({ value: 400, tolerance: 5 }),
  ],
});

interface SortableItemProps {
  id: string;
  index: number;
  text: string;
  isPending?: boolean;
  isDuplicate?: boolean;
  creatorName?: string | null;
  isOwnItem?: boolean;
  editorName?: string | null;
  isOwnEdit?: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string, newText: string) => void;
  onSkip?: (id: string, skipped: boolean) => void;
  recurring?: boolean;
  onToggleRecurring?: (id: string, recurring: boolean) => void;
  onRemoveDuplicates?: (text: string) => void;
  reminderAt?: string | null;
  onReminderTap?: (id: string) => void;
  isExiting?: boolean;
  isJustAdded?: boolean;
}

export default function SortableItem({
  id,
  index,
  text,
  isPending,
  isDuplicate,
  creatorName,
  isOwnItem,
  editorName,
  isOwnEdit,
  onToggle,
  onDelete,
  onEdit,
  onSkip,
  recurring,
  onToggleRecurring,
  onRemoveDuplicates,
  reminderAt,
  onReminderTap,
  isExiting,
  isJustAdded,
}: SortableItemProps) {
  const { ref, isDragSource } = useSortable({
    id,
    index,
    sensors: [longPressSensor],
  });

  return (
    <div
      ref={ref}
      className={`touch-pan-y select-none transition-transform duration-150 ${isDragSource ? "opacity-50 scale-[1.02] shadow-lg rounded-xl" : ""}`}
    >
      <ItemRow
        id={id}
        text={text}
        completed={false}
        isPending={isPending}
        isDuplicate={isDuplicate}
        creatorName={creatorName}
        isOwnItem={isOwnItem}
        editorName={editorName}
        isOwnEdit={isOwnEdit}
        onToggle={onToggle}
        onDelete={onDelete}
        onEdit={onEdit}
        onSkip={onSkip}
        recurring={recurring}
        onToggleRecurring={onToggleRecurring}
        onRemoveDuplicates={onRemoveDuplicates}
        reminderAt={reminderAt}
        onReminderTap={onReminderTap}
        isExiting={isExiting}
        isJustAdded={isJustAdded}
      />
    </div>
  );
}
