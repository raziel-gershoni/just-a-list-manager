"use client";

import { useCallback } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { PointerSensor, PointerActivationConstraints } from "@dnd-kit/dom";
import ListCard from "./ListCard";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";

// Module scope is load-bearing: a sensor created in the component body gets a
// new identity on every render and long-press activation stops working.
const longPressSensor = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Delay({ value: 400, tolerance: 5 }),
  ],
});

interface SortableListCardProps {
  id: string;
  index: number;
  name: string;
  type: ListType;
  icon: ListIconName | null;
  color: ListColor | null;
  activeCount: number;
  completedCount: number;
  isShared: boolean;
  role: "owner" | "view" | "edit";
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function SortableListCard({
  id,
  index,
  name,
  type,
  icon,
  color,
  activeCount,
  completedCount,
  isShared,
  role,
  onClick,
  onEdit,
  onDelete,
}: SortableListCardProps) {
  const { ref, handleRef, isDragSource } = useSortable({
    id,
    index,
    sensors: [longPressSensor],
  });

  // The handle must be set, and must cover the whole card. ListCard's root is
  // a <button>, and @dnd-kit's default preventActivation ends in
  // isInteractiveElement(target) — `target.closest("... button ...")` — so
  // every pointerdown inside a card resolves to that button and the drag
  // silently never activates. The check preventActivation makes first is
  // `source.handle?.contains(target)`, which short-circuits it.
  //
  // Pointing the handle at the same element as `ref` costs nothing: the sensor
  // binds its pointerdown listener to `source.handle ?? source.element`.
  const setCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      ref(node);
      handleRef(node);
    },
    [ref, handleRef]
  );

  return (
    <div
      ref={setCardRef}
      className={`touch-pan-y select-none transition-transform duration-150 ${isDragSource ? "opacity-50 scale-[1.02] shadow-lg rounded-2xl" : ""}`}
    >
      <ListCard
        id={id}
        name={name}
        type={type}
        icon={icon}
        color={color}
        activeCount={activeCount}
        completedCount={completedCount}
        isShared={isShared}
        role={role}
        onClick={onClick}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}
