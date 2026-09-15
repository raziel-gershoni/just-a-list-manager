# Recurring occurrence integrity — Design

**Date:** 2026-09-15
**Status:** Accepted
**Origin:** Bug report — a duplicate item in the reminders list "תזכורות", created 2026-09-07, deliberately left not-done so it could be investigated.

## The evidence

`scripts/diagnose-reminder-dupes.mjs` against production, text `לתזכר לקוחות לגבי לחם`:

```
parent  524a9c95  completed_at 2026-09-07T04:02:27.826
item    9b2edb6b  created      2026-09-07T04:02:27.843417   completed=false  weekly
item    26240c02  created      2026-09-07T04:02:27.872669   completed=false  weekly
                                              ↑ 29 milliseconds apart
```

Both successors carry their own reminder at the identical `remind_at`, and both fired on
2026-09-13 fifteen seconds apart (`04:30:11.664`, `04:30:26.699`) — the two Telegram messages
the user saw.

29ms is not a retry after a timeout. Two requests were in flight simultaneously.

## Root cause 1 — the client replays an in-flight mutation

`src/hooks/useMutationQueue.ts`:

- `addMutation` enqueues to localStorage (`:166-170`), caches the real closure in
  `pendingExecutors` (`:172`), then fires it **without awaiting** (`:176`).
- The mutation is removed from the queue only on success (`:53`).
- `flushQueue` snapshots the queue (`:96`) — which still contains the in-flight mutation —
  and prefers the cached closure (`:122`) over the harmless plain-PATCH fallback in
  `executor-factory.ts:28-41`.
- `isFlushingRef` (`:92`) guards flush-against-flush only, never flush-against-the-original-call.

A flush fires on `online`, `focus`, `visibilitychange` and a 45-minute timer
(`useReconnectOrchestrator.ts:241-248`). In a Telegram Mini App, backgrounding during a
200ms POST is routine. Both calls then succeed, and no error is logged anywhere.

The comment at `:174-175` — *"flushQueue operates on its own snapshot, so there is no
double-execution risk for newly added mutations"* — is false. The snapshot is taken at flush
time and includes anything still queued.

## Root cause 2 — the server has no idempotency

`completeRecurringItem` (`src/services/recurring.ts:19`) is the only code that mints a
follow-on occurrence. Its insert (`:53-57`) carries no `idempotency_key`, and the only unique
index on `items` is the partial `idx_items_idempotency_key`
(`supabase/migrations/009_add_idempotency_key.sql:6`) — so nothing stops a repeat.

Its step 2 (`:44-47`) marks the item completed with an unconditional `UPDATE ... WHERE id = ?`.
Combined with step 4's unconditional insert, any two invocations both succeed.

The web route `complete-recurring/route.ts` has no guard at all. The Telegram path has one
whose own comment names this exact failure (`bot.ts:437-438`, a 30-second window keyed on
`completed_at`) — but it is a check-then-act with no atomicity: in this incident both runs
read `completed = false` before either wrote, so both proceeded. The window length was never
the problem; the absence of a lock was.

This second root cause is the one that matters, because it is reachable from paths the client
fix cannot touch:

- **Stale Telegram buttons.** Nothing ever cancels a reminder — `bot.ts:449` keeps it
  deliberately so the completed item can display its time. Completing an occurrence *in the
  app* therefore leaves a live ✅ on the Telegram message forever, and
  `bot.ts:417-421` resolves it by `.eq("id", reminderId)` alone, with no `sent_at`,
  `cancelled_at` or age filter.
- **Shared fan-out.** The cron passes the same `reminder.id` to every recipient
  (`cron/reminders/route.ts:136-157` → `bot.ts:273`), and `reminder_done` has no membership
  check at all.

## Root cause 3 — snooze silently ends a recurring series

`bot.ts:563-566` clears `recurrence` when snoozing, justified by:

> the next recurring instance was already created when this reminder fired

**That has never been true.** Every revision of `app/api/cron/reminders/route.ts` back to the
original feature (`daa299f`) writes only `sent_at` and `cancelled_at` — it has never inserted
an item. The next occurrence is created on *Done*, exactly as `cron/reminders/route.ts:159`
says. The false premise entered in commit `46df943` (2026-04-18), which shipped migration
`018`.

Consequence: once `recurrence` is NULL, `bot.ts:447` takes the one-time branch and
`useItemHandlers.ts:201` computes `isRecurringDone` as falsy (the reminders GET reads
`recurrence`, `app/api/lists/[id]/reminders/route.ts:24`). Tapping Done on a snoozed recurring
reminder completes the item and creates nothing. **The series dies.**

### Why 018 over-corrected, and why reverting it is safe now

Migration `018` cleaned up "duplicate recurrence chains" — multiple live recurring reminders
on one item. Keeping `recurrence` across a snooze re-arms a message, which widens the window
for `completeRecurringItem` to run twice; the duplicate chains were a *symptom of the missing
idempotency*, not of snooze itself. `46df943` treated the symptom by disabling the feature.

With root cause 2 fixed, a second invocation cannot create an occurrence, so the chain
duplication cannot recur. **The snooze fix is only safe shipped together with the CAS**, which
is why they are one change.

## Decision

1. **Make `completeRecurringItem` idempotent with a compare-and-swap claim.** Step 2 moves to
   the front and becomes the guard: a single-statement
   `UPDATE items SET completed = true WHERE id = ? AND completed = false AND deleted_at IS NULL`.
   Under Postgres READ COMMITTED a concurrent second `UPDATE` blocks on the row lock, then
   re-evaluates its `WHERE` against the committed version — so exactly one caller gets a row
   back. The loser does nothing. This closes every double-invocation path at once: the client
   race, stale Telegram buttons, the shared fan-out, and queue retries.
   The `deleted_at IS NULL` term keeps this consistent with
   `specs/2026-09-08-delete-is-final-design.md` — a deleted item does not spawn a successor.
2. **Stop the client replaying an in-flight mutation.** Track in-flight ids and skip them in
   `flushQueue`.
3. **Stop clearing `recurrence` on snooze**, and correct the false comment.

## Accepted consequence of (3): snooze shifts the series

The next occurrence is computed from the reminder's `remind_at` (`recurring.ts:50`), which
after a snooze is the snoozed time. Snoozing a 09:00 daily reminder by 30 minutes and then
tapping Done anchors the series at 09:30. Repeated snoozing compounds the drift.

Accepted deliberately: a series that drifts is strictly better than one that dies, and the
user can reset the time. Preserving the original anchor needs a new column to carry it, which
is a larger change — recorded below as follow-up.

## Scope

**In:**
- CAS claim in `completeRecurringItem`, with a typed outcome so callers can tell
  "already completed" from a real error.
- Both callers updated: the web route returns 200 with `alreadyCompleted` rather than 500;
  the client skips its optimistic insert in that case (the winner's row arrives via Realtime).
- In-flight tracking in `MutationQueue` + `useMutationQueue`.
- Snooze keeps `recurrence`.

**Out (needs its own decision):**
- Preserving the series anchor across a snooze (needs a `series_anchor_at` column).
- Cancelling or disarming stale Telegram reminder buttons. The CAS makes a stale tap
  harmless, but the message still shows a button that now silently does nothing visible.
- The missing membership check on `reminder_done` (`bot.ts:405`) — any Telegram user who
  knows a reminder id can act on it. The CAS limits the blast radius to one completion,
  but it is still an authorization gap.
- Cleaning up the one existing duplicate row in production (`26240c02`). The user can delete
  it in-app; deletion is final as of `2026-09-08`.

## No migration

Nothing schema-side changes. The CAS uses the existing `completed` column.
