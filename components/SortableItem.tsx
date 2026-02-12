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
}: SortableItemProps) {
  const { ref, isDragSource } = useSortable({
    id,
    index,
    sensors: [longPressSensor],
  });

  return (
    <div
      ref={ref}
      className={`touch-pan-y select-none ${isDragSource ? "opacity-50" : ""}`}
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
      />
    </div>
  );
}
