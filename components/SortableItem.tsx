"use client";

import { useSortable } from "@dnd-kit/react/sortable";
import { GripVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import ItemRow from "./ItemRow";

interface SortableItemProps {
  id: string;
  index: number;
  text: string;
  isPending?: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
}

export default function SortableItem({
  id,
  index,
  text,
  isPending,
  onToggle,
  onDelete,
}: SortableItemProps) {
  const t = useTranslations();
  const { ref, handleRef, isDragSource } = useSortable({ id, index });

  return (
    <div
      ref={ref}
      className={`flex items-center ${isDragSource ? "opacity-50" : ""}`}
    >
      <button
        ref={handleRef}
        className="touch-none px-2 py-3 text-tg-hint shrink-0 cursor-grab active:cursor-grabbing"
        aria-label={t("items.dragHandle")}
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="flex-1 min-w-0">
        <ItemRow
          id={id}
          text={text}
          completed={false}
          isPending={isPending}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}
