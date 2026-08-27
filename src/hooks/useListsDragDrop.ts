"use client";

import { useRef, useCallback, useEffect } from "react";
import type { DragDropEvents } from "@dnd-kit/react";
import { getTelegramWebApp } from "@/src/types/telegram";

// How long after a drag gesture ends a click is still treated as its tail.
// Long enough to cover pointerup -> click dispatch on touch, short enough that
// a deliberate follow-up tap is never swallowed.
const CLICK_SUPPRESS_MS = 250;

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
  // on release even when it started a drag, so clicks are ignored while a drag
  // is active and for a short window after it ends. Item rows never needed
  // this — they don't navigate.
  //
  // `active` is deliberately NOT the only signal: @dnd-kit/dom 0.2.4's
  // PointerSensor binds pointerup but not pointercancel, so a gesture the OS or
  // Telegram's own swipe handling steals never produces a dragend. Window-level
  // pointercancel/pointerup listeners below clear `active` regardless, or every
  // card tap would stay dead until the page remounts.
  const dragRef = useRef({ active: false, endedAt: 0 });

  const endDrag = useCallback(() => {
    dragRef.current = { active: false, endedAt: Date.now() };
  }, []);

  useEffect(() => {
    const onPointerEnd = () => {
      if (dragRef.current.active) endDrag();
    };
    window.addEventListener("pointercancel", onPointerEnd, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    return () => {
      window.removeEventListener("pointercancel", onPointerEnd, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
    };
  }, [endDrag]);

  /** True when a click is the tail of a drag gesture and must not navigate. */
  const shouldSuppressClick = useCallback(() => {
    const { active, endedAt } = dragRef.current;
    return active || Date.now() - endedAt < CLICK_SUPPRESS_MS;
  }, []);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    previousListsRef.current = [...lists];
    dragRef.current = { active: true, endedAt: 0 };
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("medium");
  }, [lists]);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      endDrag();

      if (event.canceled) {
        setLists(previousListsRef.current);
        return;
      }

      const { source, target } = event.operation;
      if (!source || !target) return;

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
        return;
      }

      const reordered = [...lists];
      const [moved] = reordered.splice(originalIndex, 1);
      reordered.splice(projectedIndex, 0, moved);

      const snapshot = previousListsRef.current;
      const orderedIds = reordered.map((l) => l.id);

      setLists(reordered);

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
    [lists, setLists, jwtRef, onReorderFailed, endDrag]
  );

  return { handleDragStart, handleDragEnd, shouldSuppressClick };
}
