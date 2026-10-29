import type { ItemData } from "@/src/types";

/**
 * Optimistic computation for "unmark all done": flip every item the Completed
 * section shows back to active. The predicate (`completed && !deleted_at &&
 * !recurring`) is useListDerivedData's completedItems: a parked recurring
 * staple is never shown there, so it is left to respawn. The affected ids are
 * what the client sends the unmark-completed endpoint.
 * Returns a new array (unaffected items kept by reference) plus the affected
 * ids in encounter order, for the undo toast.
 */
export function computeUnmarkCompleted(
  items: ItemData[]
): { next: ItemData[]; affectedIds: string[] } {
  const affectedIds: string[] = [];
  const next = items.map((i) => {
    if (i.completed && !i.deleted_at && !i.recurring) {
      affectedIds.push(i.id);
      return { ...i, completed: false, completed_at: null };
    }
    return i;
  });
  return { next, affectedIds };
}
