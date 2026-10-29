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
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown> }) => void;
  listId: string;
  groups: CategoryGroup[] | null;
}

export function useListDragDrop({
  items,
  setItems,
  addMutation,
  listId,
  groups,
}: UseListDragDropParams) {
  const isDraggingRef = useRef(false);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    isDraggingRef.current = true;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("medium");
  }, []);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      // The items change only at a drop, so a canceled drag has nothing to put back. A copy
      // taken at the drag's start would undo what came in during it (a collaborator's change,
      // a create's answer turning a temp row into the saved row).
      if (event.canceled) {
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
        addMutation({
          id: genMutId(),
          type: "set-category",
          payload: { listId, itemId: sourceId, categoryId: moveTo },
        });
      }

      addMutation({
        id: genMutId(),
        type: "reorder",
        payload: { listId, orderedIds: updatedIds },
      });
      // The drag is over. Until the queued reorder lands, the positions on screen are
      // pending fields of the sync engine, which refresh and realtime keep.
      isDraggingRef.current = false;
    },
    [items, groups, listId, addMutation, setItems]
  );

  return { handleDragStart, handleDragEnd, isDraggingRef };
}
