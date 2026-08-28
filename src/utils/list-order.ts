/**
 * Per-user manual ordering of the home screen list.
 *
 * Positions are sparse: a list only has one once the user has actually
 * dragged. Unpositioned lists (just created, just shared with you, never
 * touched) sort ABOVE the manual order so they are immediately visible.
 */

export interface OrderableList {
  id: string;
  owner_id: string;
  updated_at: string;
}

/**
 * Sort lists for a user's home screen.
 *
 * - Unpositioned lists come first.
 * - Among positioned lists: highest position first (matches the item
 *   convention, where the top row carries the largest position).
 * - Among unpositioned lists: owned before shared, then updated_at
 *   descending — exactly the ordering GET /api/lists produced before this
 *   feature, so a user who never drags sees no change.
 * - Two lists CAN share a position (delete a list, reorder the rest, then
 *   undo the delete: the restored row keeps a position the renumbering has
 *   since reused). Those fall through to the same owned/updated_at/id rules
 *   rather than an arbitrary id compare, and the next drag renumbers them
 *   apart.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortListsByUserOrder<T extends OrderableList>(
  lists: T[],
  positions: Map<string, number>,
  userId: string
): T[] {
  return [...lists].sort((a, b) => {
    const pa = positions.get(a.id);
    const pb = positions.get(b.id);

    // Exactly one is positioned — the unpositioned one wins.
    if ((pa == null) !== (pb == null)) return pa == null ? -1 : 1;

    if (pa != null && pb != null && pa !== pb) return pb - pa;

    const aOwned = a.owner_id === userId;
    const bOwned = b.owner_id === userId;
    if (aOwned !== bOwned) return aOwned ? -1 : 1;

    if (a.updated_at !== b.updated_at) {
      return a.updated_at < b.updated_at ? 1 : -1;
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Rows for the bulk upsert into user_list_state. The first id (top of the
 * screen) gets the highest position, the last gets 1.
 */
export function buildListOrderRows(
  userId: string,
  orderedIds: string[]
): { user_id: string; list_id: string; position: number }[] {
  return orderedIds.map((listId, index) => ({
    user_id: userId,
    list_id: listId,
    position: orderedIds.length - index,
  }));
}
