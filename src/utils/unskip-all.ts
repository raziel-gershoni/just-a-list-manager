import type { ItemData } from "@/src/types";
import { isSkippedItem } from "@/src/utils/list-helpers";

/**
 * Optimistic computation for "restore all" on the Not available section: clear
 * skipped_at on every item the section shows (isSkippedItem). The affected ids are
 * what the unskip-all endpoint is sent, so client and server change the same rows.
 * Positions are kept, so items return to where they were. Returns a new array
 * (unaffected items kept by reference) plus the affected ids in encounter order.
 */
export function computeUnskipAll(
  items: ItemData[]
): { next: ItemData[]; affectedIds: string[] } {
  const affectedIds: string[] = [];
  const next = items.map((i) => {
    if (isSkippedItem(i)) {
      affectedIds.push(i.id);
      return { ...i, skipped_at: null };
    }
    return i;
  });
  return { next, affectedIds };
}
