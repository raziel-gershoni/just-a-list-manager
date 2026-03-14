"use client";

import { useMemo } from "react";
import type { ItemData } from "@/src/types";
import { groupByCompletionTime } from "@/src/utils/list-helpers";

export function useListDerivedData(
  items: ItemData[],
  t: (key: string) => string
) {
  const activeItems = useMemo(
    () =>
      items
        .filter((i) => !i.completed && !i.deleted_at && !i.skipped_at)
        .sort((a, b) => b.position - a.position),
    [items]
  );

  const skippedItems = useMemo(
    () =>
      items
        .filter((i) => !i.completed && !i.deleted_at && !!i.skipped_at)
        .sort((a, b) => b.position - a.position),
    [items]
  );

  const completedItems = useMemo(
    () =>
      items
        .filter((i) => i.completed && !i.deleted_at)
        .sort((a, b) => {
          const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0;
          const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0;
          return aTime - bTime;
        }),
    [items]
  );

  const completedGroups = useMemo(
    () => groupByCompletionTime(completedItems, t),
    [completedItems, t]
  );

  const duplicateTexts = useMemo(() => {
    const result = new Set<string>();
    const seenTexts = new Map<string, number>();
    for (const item of items.filter((i) => !i.deleted_at)) {
      const key = item.text.toLowerCase();
      seenTexts.set(key, (seenTexts.get(key) || 0) + 1);
    }
    for (const [key, count] of seenTexts) {
      if (count > 1) result.add(key);
    }
    return result;
  }, [items]);

  return { activeItems, skippedItems, completedItems, completedGroups, duplicateTexts };
}
