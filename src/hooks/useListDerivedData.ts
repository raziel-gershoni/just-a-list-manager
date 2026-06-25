"use client";

import { useMemo } from "react";
import type { ItemData } from "@/src/types";
import { groupByCompletionTime, isActiveItem, isSkippedItem } from "@/src/utils/list-helpers";
import { computeDuplicateTexts } from "@/src/utils/duplicate-detection";

export function useListDerivedData(
  items: ItemData[],
  t: (key: string) => string
) {
  const activeItems = useMemo(
    () => items.filter(isActiveItem).sort((a, b) => b.position - a.position),
    [items]
  );

  const skippedItems = useMemo(
    () => items.filter(isSkippedItem).sort((a, b) => b.position - a.position),
    [items]
  );

  const completedItems = useMemo(
    () =>
      items
        .filter((i) => i.completed && !i.deleted_at && !i.recurring)
        .sort((a, b) => {
          const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0;
          const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0;
          return aTime - bTime;
        }),
    [items]
  );

  const recurringItems = useMemo(
    () =>
      items
        .filter((i) => i.recurring && (i.completed || !!i.deleted_at))
        .sort((a, b) => {
          const aTime = new Date(a.completed_at ?? a.deleted_at ?? 0).getTime();
          const bTime = new Date(b.completed_at ?? b.deleted_at ?? 0).getTime();
          return aTime - bTime;
        }),
    [items]
  );

  const completedGroups = useMemo(
    () => groupByCompletionTime(completedItems, t),
    [completedItems, t]
  );

  const duplicateTexts = useMemo(() => computeDuplicateTexts(items), [items]);

  return { activeItems, skippedItems, recurringItems, completedItems, completedGroups, duplicateTexts };
}
