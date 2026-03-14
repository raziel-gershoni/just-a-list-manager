"use client";

import { useRef, useCallback } from "react";
import type { DragDropEvents } from "@dnd-kit/react";
import type { ItemData } from "@/src/types";
import { getTelegramWebApp } from "@/src/types/telegram";
import { genMutId } from "@/src/utils/list-helpers";

interface UseListDragDropParams {
  items: ItemData[];
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> }) => void;
  listId: string;
  jwtRef: React.RefObject<string | null>;
}

export function useListDragDrop({
  items,
  setItems,
  addMutation,
  listId,
  jwtRef,
}: UseListDragDropParams) {
  const isDraggingRef = useRef(false);
  const previousItemsRef = useRef<ItemData[]>([]);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    isDraggingRef.current = true;
    previousItemsRef.current = [...items];
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("medium");
  }, [items]);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      if (event.canceled) {
        setItems(previousItemsRef.current);
        isDraggingRef.current = false;
        return;
      }

      const { source, target } = event.operation;
      if (!source || !target) {
        isDraggingRef.current = false;
        return;
      }

      const sourceId = source.id as string;
      const projectedIndex = (source as { sortable?: { index: number } }).sortable?.index;

      // Compute new order from current active items
      const currentActive = items
        .filter((i) => !i.completed && !i.deleted_at && !i.skipped_at)
        .sort((a, b) => b.position - a.position);

      const originalIndex = currentActive.findIndex((i) => i.id === sourceId);

      if (originalIndex === -1 || projectedIndex == null || originalIndex === projectedIndex) {
        isDraggingRef.current = false;
        return;
      }

      const reordered = [...currentActive];
      const [moved] = reordered.splice(originalIndex, 1);
      reordered.splice(projectedIndex, 0, moved);

      // Assign new positions (highest position = first item)
      const updatedIds: string[] = [];
      const positionMap = new Map<string, number>();
      reordered.forEach((item, index) => {
        const newPosition = reordered.length - index;
        positionMap.set(item.id, newPosition);
        updatedIds.push(item.id);
      });

      // Update items state with new positions
      setItems((prev) =>
        prev.map((item) => {
          const newPos = positionMap.get(item.id);
          if (newPos != null) return { ...item, position: newPos };
          return item;
        })
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "reorder",
        payload: { listId, orderedIds: updatedIds },
        execute: async () => {
          try {
            const jwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items/reorder`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ orderedIds: updatedIds }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
          } finally {
            isDraggingRef.current = false;
          }
        },
      });
    },
    [items, jwtRef, listId, addMutation, setItems]
  );

  return { handleDragStart, handleDragEnd, isDraggingRef };
}
