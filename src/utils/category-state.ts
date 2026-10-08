import type { ListCategory, RealtimeChange } from "@/src/types";

export function sortCategories(categories: ListCategory[]): ListCategory[] {
  return [...categories].sort((a, b) => a.position - b.position);
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
