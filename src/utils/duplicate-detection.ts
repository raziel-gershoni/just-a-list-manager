import { normalizeForCompare } from "@/src/utils/text-normalize";

export function computeDuplicateTexts(
  items: { text: string; deleted_at: string | null; completed?: boolean; recurring?: boolean }[]
): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.deleted_at) continue;
    // A parked recurring staple (bought or paused) is waiting to come back, not a copy.
    // Same rule as isParkedRecurringItem in list-helpers.
    if (item.recurring && item.completed) continue;
    const key = normalizeForCompare(item.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [key, n] of counts) {
    if (n > 1) result.add(key);
  }
  return result;
}

