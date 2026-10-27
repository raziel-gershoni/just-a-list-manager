import { differenceInCalendarDays } from "date-fns";
import type { ItemData, CompletedGroup, CategoryGroup, ListCategory } from "@/src/types";
import { categoryLabel } from "@/src/types/categories";

export function genMutId(): string {
  return `mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function lookupUserName(items: ItemData[], targetUserId: string | null): string | null {
  if (!targetUserId) return null;
  for (const item of items) {
    if (item.created_by === targetUserId && item.creator_name) return item.creator_name;
    if (item.edited_by === targetUserId && item.editor_name) return item.editor_name;
  }
  return null;
}

export function groupByCompletionTime(
  items: ItemData[],
  t: (key: string) => string
): CompletedGroup[] {
  const now = new Date();

  // Age is counted in local calendar days (0 = today, 1 = yesterday), so an item
  // done late last night is "Yesterday" this morning. Youngest first: an item
  // goes to the first bucket whose limit is above its age.
  const buckets: { key: string; maxDays: number }[] = [
    { key: "today", maxDays: 1 },
    { key: "yesterday", maxDays: 2 },
    { key: "daysAgo", maxDays: 7 },
    { key: "weekAgo", maxDays: 14 },
    { key: "weeksAgo", maxDays: 30 },
    { key: "monthAgo", maxDays: 60 },
    { key: "monthsAgo", maxDays: 180 },
    { key: "longAgo", maxDays: Infinity },
  ];

  const grouped = new Map<string, ItemData[]>();
  for (const b of buckets) grouped.set(b.key, []);

  for (const item of items) {
    const days = item.completed_at
      ? differenceInCalendarDays(now, new Date(item.completed_at))
      : Infinity;
    // No completion time (or an unparseable one) matches no limit: longAgo.
    const bucket = buckets.find((b) => days < b.maxDays) ?? buckets[buckets.length - 1];
    grouped.get(bucket.key)!.push(item);
  }

  // Return non-empty groups oldest first, like the completed items themselves
  return [...buckets]
    .reverse()
    .filter((b) => grouped.get(b.key)!.length > 0)
    .map((b) => ({
      label: t(`items.completedTime.${b.key}`),
      items: grouped.get(b.key)!,
    }));
}

export const SORTING_GROUP = "sorting";

/**
 * Active grocery items grouped for the store walk: anything not yet sorted first,
 * then each non-empty category in walk order. Item order inside a group is kept.
 */
export function groupByCategory(
  active: ItemData[],
  categories: ListCategory[],
  locale: string,
  sortingLabel: string
): CategoryGroup[] {
  const known = new Set(categories.map((c) => c.id));
  const byCategory = new Map<string, ItemData[]>();
  const sorting: ItemData[] = [];
  for (const item of active) {
    const id = item.category_id;
    if (id && known.has(id)) {
      const bucket = byCategory.get(id) ?? [];
      bucket.push(item);
      byCategory.set(id, bucket);
    } else {
      sorting.push(item);
    }
  }
  const groups: CategoryGroup[] = [];
  if (sorting.length) groups.push({ key: SORTING_GROUP, categoryId: null, label: sortingLabel, items: sorting });
  for (const c of [...categories].sort((a, b) => a.position - b.position)) {
    const items = byCategory.get(c.id);
    if (items?.length) groups.push({ key: c.id, categoryId: c.id, label: categoryLabel(c, locale), items });
  }
  return groups;
}

// Item grouping predicates. "Ordered" items stay in the active list (shown
// with an in-row badge), so only completion / skip / delete move an item out.
export const isSkippedItem = (i: ItemData): boolean =>
  !i.completed && !i.deleted_at && !!i.skipped_at;

export const isActiveItem = (i: ItemData): boolean =>
  !i.completed && !i.deleted_at && !i.skipped_at;

// A recurring staple waiting to come back. Only completion parks an item here —
// deleting is final, so a soft-deleted row is never listed.
export const isParkedRecurringItem = (i: ItemData): boolean =>
  !!i.recurring && i.completed && !i.deleted_at;

/** Items still to buy per category: what each header in the grouped list holds. */
export function countByCategory(items: ItemData[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (isActiveItem(item) && item.category_id) {
      counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1);
    }
  }
  return counts;
}
