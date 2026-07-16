import type { ItemData } from "@/src/types";

/**
 * Optimistic computation for "unmark all done": flip every completed,
 * non-deleted item back to active. The predicate (`completed && !deleted_at`)
 * matches the unmark-completed endpoint's filter so client and server agree.
 * Returns a new array (unaffected items kept by reference) plus the affected
 * ids in encounter order, for the undo toast.
 */
export function computeUnmarkCompleted(
  items: ItemData[]
): { next: ItemData[]; affectedIds: string[] } {
  const affectedIds: string[] = [];
  const next = items.map((i) => {
    if (i.completed && !i.deleted_at) {
      affectedIds.push(i.id);
      return { ...i, completed: false, completed_at: null };
    }
    return i;
  });
  return { next, affectedIds };
}
