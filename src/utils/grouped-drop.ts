import type { CategoryGroup } from "@/src/types";
import { SORTING_GROUP } from "@/src/utils/list-helpers";

/**
 * Where a drag in the grouped grocery list lands: the full active order in display order
 * (for the existing reorder request) and, when the item changed category, the new one.
 * Returns null for a drop that changes nothing or lands in the "Sorting…" group.
 */
export function computeGroupedDrop(
  groups: CategoryGroup[],
  sourceId: string,
  targetGroup: string | undefined,
  targetIndex: number | undefined
): { orderedIds: string[]; moveTo: string | null } | null {
  if (!targetGroup || targetGroup === SORTING_GROUP || targetIndex == null) return null;
  const from = groups.find((g) => g.items.some((i) => i.id === sourceId));
  const to = groups.find((g) => g.key === targetGroup);
  if (!from || !to || to.categoryId === null) return null;

  const fromIndex = from.items.findIndex((i) => i.id === sourceId);
  if (from === to && fromIndex === targetIndex) return null;

  const next = groups.map((g) => ({ key: g.key, ids: g.items.map((i) => i.id) }));
  const source = next.find((g) => g.key === from.key)!;
  const target = next.find((g) => g.key === to.key)!;
  source.ids.splice(fromIndex, 1);
  target.ids.splice(Math.min(Math.max(targetIndex, 0), target.ids.length), 0, sourceId);

  return { orderedIds: next.flatMap((g) => g.ids), moveTo: from === to ? null : to.categoryId };
}
