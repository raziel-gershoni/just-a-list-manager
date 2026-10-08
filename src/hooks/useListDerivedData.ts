"use client";

import { useMemo } from "react";
import type { ItemData, ListCategory } from "@/src/types";
import {
  groupByCategory,
  groupByCompletionTime,
  isActiveItem,
  isSkippedItem,
  isParkedRecurringItem,
} from "@/src/utils/list-helpers";
import { computeDuplicateTexts } from "@/src/utils/duplicate-detection";
import { respawnAnchor } from "@/src/utils/recurring-respawn";

type GroupingOptions = { categories: ListCategory[]; locale: string; grouped: boolean };

const NO_GROUPING: GroupingOptions = { categories: [], locale: "en", grouped: false };

export function useListDerivedData(
  items: ItemData[],
  t: (key: string) => string,
  options: GroupingOptions = NO_GROUPING
) {
  const { categories, locale, grouped } = options;

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
        .filter(isParkedRecurringItem)
        .sort((a, b) => {
          const aTime = new Date(respawnAnchor(a) ?? 0).getTime();
          const bTime = new Date(respawnAnchor(b) ?? 0).getTime();
          return aTime - bTime;
        }),
    [items]
  );

  const completedGroups = useMemo(
    () => groupByCompletionTime(completedItems, t),
    [completedItems, t]
  );

  const categoryGroups = useMemo(
    () => (grouped ? groupByCategory(activeItems, categories, locale, t("categories.sorting")) : null),
    [activeItems, grouped, categories, locale, t]
  );

  const duplicateTexts = useMemo(() => computeDuplicateTexts(items), [items]);

  return { activeItems, skippedItems, recurringItems, completedItems, completedGroups, categoryGroups, duplicateTexts };
}
