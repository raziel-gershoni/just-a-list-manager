"use client";

import { useRef, useCallback } from "react";
import type { DragDropEvents } from "@dnd-kit/react";
import type { ItemData, CategoryGroup } from "@/src/types";
import { getTelegramWebApp } from "@/src/types/telegram";
import { genMutId } from "@/src/utils/list-helpers";
import { computeGroupedDrop } from "@/src/utils/grouped-drop";

interface UseListDragDropParams {
  items: ItemData[];
  setItems: React.Dispatch<React.SetStateAction<ItemData[]>>;
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> }) => void;
  listId: string;
  jwtRef: React.RefObject<string | null>;
  groups: CategoryGroup[] | null;
}

export function useListDragDrop({
  items,
  setItems,
  addMutation,
  listId,
  jwtRef,
  groups,
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
      const sortable = (source as { sortable?: { index: number; group?: string } }).sortable;
      const projectedIndex = sortable?.index;

      let updatedIds: string[];
      let moveTo: string | null = null;
      if (groups) {
        const drop = computeGroupedDrop(groups, sourceId, sortable?.group as string | undefined, projectedIndex);
        if (!drop) {
          isDraggingRef.current = false;
          return;
        }
        updatedIds = drop.orderedIds;
        moveTo = drop.moveTo;
      } else {
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
        updatedIds = reordered.map((i) => i.id);
      }

      // Assign new positions (highest position = first item)
      const positionMap = new Map<string, number>();
      updatedIds.forEach((id, index) => {
        positionMap.set(id, updatedIds.length - index);
      });

      // Update items state with new positions, and the new category for a moved item
      setItems((prev) =>
        prev.map((item) => {
          const newPos = positionMap.get(item.id);
          let next = newPos != null ? { ...item, position: newPos } : item;
          if (moveTo && item.id === sourceId) next = { ...next, category_id: moveTo, category_locked: true };
          return next;
        })
      );

      if (moveTo) {
        const categoryId = moveTo;
        addMutation({
          id: genMutId(),
          type: "set-category",
          payload: { listId, itemId: sourceId, categoryId },
          execute: async () => {
            const jwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: sourceId, categoryId }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Set category failed: ${res.status}`);
          },
        });
      }

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
    [items, groups, jwtRef, listId, addMutation, setItems]
  );

  return { handleDragStart, handleDragEnd, isDraggingRef };
}
