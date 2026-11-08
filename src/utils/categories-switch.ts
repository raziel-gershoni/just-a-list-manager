// The one rule for whether a list's items are sorted into categories (the per-list switch,
// docs/superpowers/specs/2026-11-08-categories-switch-design.md).

/** A grocery list with its categories switch on. Unknown is not on: it must never spend AI. */
export function sortsIntoCategories(
  list: { type?: string | null; categories_enabled?: boolean | null } | null | undefined
): boolean {
  return list?.type === "grocery" && list.categories_enabled === true;
}
