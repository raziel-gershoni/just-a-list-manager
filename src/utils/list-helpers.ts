import type { ItemData, CompletedGroup } from "@/src/types";

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
  const now = Date.now();
  const hour = 3600_000;
  const day = 24 * hour;

  const buckets: { key: string; maxAge: number }[] = [
    { key: "longAgo", maxAge: Infinity },
    { key: "monthsAgo", maxAge: 180 * day },
    { key: "monthAgo", maxAge: 60 * day },
    { key: "weeksAgo", maxAge: 30 * day },
    { key: "weekAgo", maxAge: 14 * day },
    { key: "daysAgo", maxAge: 7 * day },
    { key: "yesterday", maxAge: 2 * day },
    { key: "today", maxAge: 1 * day },
  ];

  const grouped = new Map<string, ItemData[]>();
  for (const b of buckets) grouped.set(b.key, []);

  for (const item of items) {
    const age = item.completed_at
      ? now - new Date(item.completed_at).getTime()
      : Infinity;
    // Find first bucket where age >= maxAge (oldest-first order)
    let placed = false;
    for (const b of buckets) {
      if (age >= b.maxAge) {
        grouped.get(b.key)!.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) grouped.get("today")!.push(item);
  }

  // Return non-empty groups in oldest-first order (matches buckets array order)
  return buckets
    .filter((b) => grouped.get(b.key)!.length > 0)
    .map((b) => ({
      label: t(`items.completedTime.${b.key}`),
      items: grouped.get(b.key)!,
    }));
}
