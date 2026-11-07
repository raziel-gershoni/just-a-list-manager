import { addWeeks, startOfWeek } from "date-fns";

/**
 * When a recurring grocery staple comes back.
 *
 * Recurring items return to the active list 4 hours after being COMPLETED, or, when the household
 * marked them "Not needed this week", when that week ends (`paused_until`).
 * Deleting is final: a soft-deleted item never respawns, whatever else is set
 * on it. Before this rule existed the anchor fell through to `deleted_at`,
 * which made a deleted recurring item impossible to remove — it returned every
 * 4 hours forever, and the 7-day purge cron could never reach it because each
 * respawn cleared `deleted_at`.
 */

export const RESPAWN_AFTER_MS = 4 * 60 * 60 * 1000;

// "Not needed this week" lasts until the week ends: an Israeli week, Sunday to Saturday.
export const WEEK_STARTS_ON = 0;

export interface RespawnCandidate {
  recurring?: boolean;
  completed_at?: string | null;
  deleted_at?: string | null;
  paused_until?: string | null;
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

/**
 * When a parked staple comes back (ms since epoch), or null if it never comes back on its own:
 * the end of its "Not needed this week" pause, else 4 hours after it was ticked.
 */
export function respawnAt(item: RespawnCandidate): number | null {
  const anchor = respawnAnchor(item);
  if (anchor === null) return null;
  if (item.paused_until) return Date.parse(item.paused_until);
  return Date.parse(anchor) + RESPAWN_AFTER_MS;
}

export function shouldRespawn(item: RespawnCandidate, now: number): boolean {
  const at = respawnAt(item);
  return at !== null && now > at;
}

/** When the week containing `now` ends: the next Sunday 00:00 on this device's clock. Always after `now`. */
export function weekEnd(now: Date): Date {
  return startOfWeek(addWeeks(now, 1), { weekStartsOn: WEEK_STARTS_ON });
}
