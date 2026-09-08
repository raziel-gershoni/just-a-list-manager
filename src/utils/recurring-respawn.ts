/**
 * When a recurring grocery staple comes back.
 *
 * Recurring items return to the active list 4 hours after being COMPLETED.
 * Deleting is final: a soft-deleted item never respawns, whatever else is set
 * on it. Before this rule existed the anchor fell through to `deleted_at`,
 * which made a deleted recurring item impossible to remove — it returned every
 * 4 hours forever, and the 7-day purge cron could never reach it because each
 * respawn cleared `deleted_at`.
 */

export const RESPAWN_AFTER_MS = 4 * 60 * 60 * 1000;

export interface RespawnCandidate {
  recurring?: boolean;
  completed_at?: string | null;
  deleted_at?: string | null;
}

/**
 * The timestamp the respawn countdown runs from, or null if this item should
 * never come back on its own.
 */
export function respawnAnchor(item: RespawnCandidate): string | null {
  if (!item.recurring) return null;
  if (item.deleted_at) return null;
  return item.completed_at ?? null;
}

export function shouldRespawn(item: RespawnCandidate, now: number): boolean {
  const anchor = respawnAnchor(item);
  if (anchor === null) return false;
  return now - new Date(anchor).getTime() > RESPAWN_AFTER_MS;
}
