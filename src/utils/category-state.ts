import type { ItemData, ListCategory, RealtimeChange } from "@/src/types";

export function sortCategories(categories: ListCategory[]): ListCategory[] {
  return [...categories].sort((a, b) => a.position - b.position);
}

/** Every item out of its category, hand placements unlocked: what turning categories off leaves.
 *  The same array when no item had either, so an idle call re-renders nothing. */
export function clearItemCategories(items: ItemData[]): ItemData[] {
  if (!items.some((i) => i.category_id || i.category_locked)) return items;
  return items.map((i) => (i.category_id || i.category_locked ? { ...i, category_id: null, category_locked: false } : i));
}

/** Apply one Realtime change on list_categories to the client's category list. */
export function applyCategoryChange(categories: ListCategory[], change: RealtimeChange): ListCategory[] {
  if (change.eventType === "DELETE") {
    const id = change.old.id as string | undefined;
    return categories.filter((c) => c.id !== id);
  }
  const incoming = change.new as unknown as ListCategory;
  if (!incoming?.id) return categories;
  const rest = categories.filter((c) => c.id !== incoming.id);
  return sortCategories([...rest, incoming]);
}

// Undo helpers for a failed sheet change. Each undoes only its own change, so
// Realtime rows that arrived during the request (an AI rescan, a collaborator) stay.

/** Undo an optimistic rename: put back the one name the sheet changed. */
export function restoreCategoryName(categories: ListCategory[], original: ListCategory, locale: string): ListCategory[] {
  const key = `name_${locale}` as "name_en" | "name_he" | "name_ru";
  return categories.map((c) => (c.id === original.id ? { ...c, [key]: original[key] } : c));
}

/** Undo an optimistic delete: put the category back unless it is already there. */
export function restoreCategory(categories: ListCategory[], original: ListCategory): ListCategory[] {
  if (categories.some((c) => c.id === original.id)) return categories;
  return sortCategories([...categories, original]);
}

/** Undo an optimistic reorder: put back each category's earlier position. */
export function restorePositions(categories: ListCategory[], before: ListCategory[]): ListCategory[] {
  const positions = new Map(before.map((c) => [c.id, c.position]));
  return sortCategories(categories.map((c) => (positions.has(c.id) ? { ...c, position: positions.get(c.id)! } : c)));
}
