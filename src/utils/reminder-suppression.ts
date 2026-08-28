/**
 * Whether a due reminder should actually be delivered, and to whom.
 *
 * Two rules beyond the item-level ones the cron already applies:
 *
 * - The list is soft-deleted -> cancel. Deleting a list did NOT previously stop
 *   its reminders, so they kept firing for the 30 days until the purge cron
 *   hard-deleted the list.
 * - A recipient archived the list -> don't notify that person. Archive is
 *   per-user, so other collaborators still get theirs.
 *
 * Anything not delivered must still be STAMPED. The cron selects due, unstamped
 * reminders with .limit(50); an unstamped reminder that is never sent occupies
 * a slot forever and eventually starves real ones. "stamp-sent" rather than
 * "cancel" for the archived case, because cancelling is the harsher, item-
 * deleted semantic — though note that unarchiving does not resurrect a
 * past-due reminder either way.
 */

export type ReminderAction =
  | { kind: "cancel" }
  | { kind: "stamp-sent" }
  | { kind: "send"; recipients: string[] };

export function decideReminderDelivery({
  listDeletedAt,
  recipients,
  archivedBy,
}: {
  listDeletedAt: string | null;
  recipients: string[];
  archivedBy: Set<string>;
}): ReminderAction {
  if (listDeletedAt) return { kind: "cancel" };

  const live = recipients.filter((userId) => !archivedBy.has(userId));
  if (live.length === 0) return { kind: "stamp-sent" };

  return { kind: "send", recipients: live };
}
