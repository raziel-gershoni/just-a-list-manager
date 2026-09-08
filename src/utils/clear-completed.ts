import type { ItemData } from "@/src/types";

/**
 * A completed, non-deleted, non-recurring item — the set "Clear completed"
 * removes. Recurring rows are excluded on purpose: the original feature
 * contract (commit bea02b3) is "auto-respawn to active 4 hours after being
 * completed or cleared." Delete-is-final vetoes respawn on `deleted_at`
 * (`src/utils/recurring-respawn.ts`), so soft-deleting a parked recurring
 * staple here would retire it permanently instead of returning it on its
 * completion clock. See
 * docs/superpowers/specs/2026-09-08-delete-is-final-design.md.
 */
function isClearable(item: ItemData): boolean {
  return item.completed && !item.deleted_at && !item.recurring;
}

/**
 * Optimistic computation for "clear completed": split items into the ones
 * to remove (`cleared`, also the undo snapshot and toast count) and the ones
 * that stay (`remaining`). The predicate matches the clear-completed
 * endpoint's filter so client and server agree.
 */
export function computeClearCompleted(
  items: ItemData[]
): { cleared: ItemData[]; remaining: ItemData[] } {
  const cleared: ItemData[] = [];
  const remaining: ItemData[] = [];
  for (const item of items) {
    (isClearable(item) ? cleared : remaining).push(item);
  }
  return { cleared, remaining };
}
