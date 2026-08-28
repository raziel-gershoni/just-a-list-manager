/**
 * Archive is a per-user view filter, not a state change on the list: a list
 * archived by one collaborator stays active for everyone else. The archived
 * set comes from user_list_state rows with a non-null archived_at.
 */

export type ListView = "active" | "archived";

/** Keep only the lists belonging to the requested view. Input is not mutated. */
export function filterListsByView<T extends { id: string }>(
  lists: T[],
  archivedIds: Set<string>,
  view: ListView
): T[] {
  return lists.filter((list) =>
    view === "archived" ? archivedIds.has(list.id) : !archivedIds.has(list.id)
  );
}
