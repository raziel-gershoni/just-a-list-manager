"use client";

import { useRef, useCallback } from "react";
import type { DragDropEvents } from "@dnd-kit/react";
import { getTelegramWebApp } from "@/src/types/telegram";

interface ReorderableList {
  id: string;
}

interface UseListsDragDropParams<T extends ReorderableList> {
  lists: T[];
  setLists: React.Dispatch<React.SetStateAction<T[]>>;
  jwtRef: React.RefObject<string | null>;
  onReorderFailed: () => void;
}

export function useListsDragDrop<T extends ReorderableList>({
  lists,
  setLists,
  jwtRef,
  onReorderFailed,
}: UseListsDragDropParams<T>) {
  const previousListsRef = useRef<T[]>([]);
  // ListCard's root is a <button> that navigates. A long-press fires a click
  // on release even when it started a drag, so navigation is suppressed for a
  // tick after the gesture ends. Item rows never needed this — they don't
  // navigate.
  const suppressClickRef = useRef(false);

  const releaseClickGuard = useCallback(() => {
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    previousListsRef.current = [...lists];
    suppressClickRef.current = true;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("medium");
  }, [lists]);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      if (event.canceled) {
        setLists(previousListsRef.current);
        releaseClickGuard();
        return;
      }

      const { source, target } = event.operation;
      if (!source || !target) {
        releaseClickGuard();
        return;
      }

      const sourceId = source.id as string;
      // `sortable` exists at runtime but not on the base Draggable type.
      const projectedIndex = (source as { sortable?: { index: number } })
        .sortable?.index;
      const originalIndex = lists.findIndex((l) => l.id === sourceId);

      if (
        originalIndex === -1 ||
        projectedIndex == null ||
        originalIndex === projectedIndex
      ) {
        releaseClickGuard();
        return;
      }

      const reordered = [...lists];
      const [moved] = reordered.splice(originalIndex, 1);
      reordered.splice(projectedIndex, 0, moved);

      const snapshot = previousListsRef.current;
      const orderedIds = reordered.map((l) => l.id);

      setLists(reordered);
      releaseClickGuard();

      const jwt = jwtRef.current;
      fetch("/api/lists/reorder", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orderedIds }),
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
        })
        .catch((e) => {
          console.error("[Home] Reorder error:", e);
          setLists(snapshot);
          onReorderFailed();
        });
    },
    [lists, setLists, jwtRef, onReorderFailed, releaseClickGuard]
  );

  return { handleDragStart, handleDragEnd, suppressClickRef };
}
