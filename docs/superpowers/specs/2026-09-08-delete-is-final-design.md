# Delete Is Final — Design

**Date:** 2026-09-08
**Status:** Accepted
**Origin:** Bug report — "there is an olive oil duplicate in my groceries list that keeps coming back."

## The rule

> Deleting an item deletes it. A soft-deleted item is restored **only** by an explicit
> user gesture in that moment (the Undo toast, or a restore button on a row the user can
> see). Nothing restores a deleted item on a timer, on fetch, on reconnect, or on replay.

Completion-based respawn for recurring grocery staples is unchanged and stays.

## Why this is a change

`recurring` is a grocery-only flag (`app/list/[id]/page.tsx:259`). Its intended contract,
per the commit that introduced it (`bea02b3`), is:

> Recurring grocery staples (e.g. milk, bread) auto-respawn to active 4 hours after being
> **completed or cleared**

Delete is not in that sentence, and no spec or plan exists for the feature. Delete-respawn
entered as a single `??` fallback with no decision behind it:

```ts
// src/hooks/useListData.ts:131
const respawnAnchor = base.completed_at ?? base.deleted_at ?? null;
```

Fed by a deliberately widened GET (`app/api/lists/[id]/items/route.ts:41`):

```ts
.or("deleted_at.is.null,recurring.eq.true")
```

### The observed loop

1. An item is marked recurring (the unlabelled 🔁 in `components/ItemRow.tsx:236-255`,
   28px, wedged between "on the way" and delete, with no toast and no undo).
2. It is completed → excluded from Done (`useListDerivedData.ts:25` `!i.recurring`) and
   parked in the **collapsed-by-default** Recurring drawer (`app/list/[id]/page.tsx:62-66`).
3. The user re-adds the same text. The add-time check (`useItemHandlers.ts:114-116`) only
   inspects rows that are `!completed && !deleted_at && !skipped_at`, so the parked twin is
   invisible — and the check is a toast that never blocks the insert. **Second row created.**
4. Four hours later the parked row respawns at `position: Date.now()`, landing at the top.
   **The duplicate becomes visible.**
5. The user deletes it. `DELETE` soft-deletes and never touches `recurring`
   (`items/route.ts:401-406`). GET still ships the row. Four hours later it returns.
6. The 7-day purge (`supabase/migrations/002_cleanup_cron.sql:10`) can never reach it,
   because every respawn nulls `deleted_at` and restarts the clock.

A recurring item is the only row in the database that cannot be deleted.

### The escape hatch is also broken

The Recurring drawer's "stop recurring" button sends `{ itemId, recurring: false }`
(`useItemHandlers.ts:448`). `deleted_at` is `z.null().optional()` (`schemas/items.ts:27`),
so it arrives `undefined`, and `items/route.ts:354` reads:

```ts
if (patchData.deleted_at !== null) {
  query = query.is("deleted_at", null);
}
```

`undefined !== null` → the active-rows filter is applied → zero rows match a deleted row →
`.single()` errors → **404**, classified by `useMutationQueue.ts:75-81` as permanently
dropped. So a user who finds the drawer still cannot stop a delete-parked item from
returning. The same button works on a completion-parked row, which makes it read as random.

## Decision

Make the respawn anchor refuse soft-deleted rows, stop shipping them to the client, and
stop the server from clearing `deleted_at` as a side effect of `restoreRecurring`.

**Only recurring items were ever auto-restored** — confirmed by an exhaustive sweep of every
writer of `deleted_at`. The six other restore paths (three Undo toasts, the drawer's restore
button, autocomplete recycle, list-undo) are all direct user gestures and are unchanged.

## Scope

**In:**
- `respawnAnchor` refuses any row with `deleted_at` set.
- `GET /api/lists/[id]/items` returns only non-deleted rows.
- The Recurring drawer lists only completion-parked rows.
- `restoreRecurring` stops clearing `deleted_at` server-side, so the existing
  `.is("deleted_at", null)` guard protects deleted rows for free.
- "Clear completed" excludes recurring rows, server and client, so it cannot silently
  retire a parked staple — see Finding 1 of the fix wave
  (`.superpowers/sdd/2026-09-08-delete-is-final/fix-wave-report.md`). Clearing a
  grocery list leaves recurring staples parked in the Recurring drawer on their
  completion clock; it does not touch them at all.

**Already decided elsewhere — do not re-litigate:**
- The duplicate-creation half was ruled on in
  `docs/superpowers/specs/2026-06-04-text-normalize-for-active-dupes-design.md`.
  - **Settled.** "Behavior on match stays as today: warning toast for 2.5s, item still gets
    added. No hard block, no 'add anyway' button." The add-time check is advisory *by
    design*; it is not a weak guard.
  - **Deliberately deferred**, on that spec's punt list: voice-add going through the same
    normalizer, and "a pg_trgm-based active-vs-active fuzzy check on the server (would
    require a new or extended RPC and a sensible threshold)."
  - That spec's Motivation already documents the limitation: `find_fuzzy_items` "only
    matches against completed / recently-deleted items, so it never sees active-vs-active"
    (live definition `supabase/migrations/010_position_bigint.sql:56-76`, superseding the
    copy in `008_security_fixes.sql`). Partial follow-through since: the
    `2026-06-04-normalize-on-add` work touched `voice-handler.ts:417`, but only to
    canonicalize stored text — voice's duplicate *matching* is unchanged.

**Out (tracked separately, needs its own decision):**
- `POST /items` passes a client-supplied `recycleId` straight into `recycleItem`
  (`items/route.ts:225`), which has no `deleted_at` guard and **no `list_id` scoping**
  (`item-recycler.ts:79-92`) — a cross-list write vector. This half of the queued-replay
  hole is still open; the other half (`restoreRecurring`) was closed above.
- Grocery lists get only the destructive "Clear completed"; the non-destructive
  "Unmark all done" is gated to `listType === "regular"` (`app/list/[id]/page.tsx:303`).

## No migration or backfill

Rows currently sitting at `recurring = true AND deleted_at IS NOT NULL` (including the
reported olive oil) become invisible the moment GET narrows, stop respawning, and are
purged normally by the existing 7-day cron. Undo within its window still works, because
Undo sends an explicit `deleted_at: null`.

## Behaviour after the change

| state | shows in | respawns |
|---|---|---|
| active | main list | — |
| completed, recurring | Recurring drawer | 4h after `completed_at` |
| deleted (recurring or not) | nowhere | never; purged after 7 days |

Deleting a recurring item behaves like deleting anything else: gone, undoable for 4
seconds, purged after 7 days. To retire a staple permanently: toggle 🔁 off while it is
active, then delete.

"Clear completed" only ever soft-deletes non-recurring completed rows. Clearing a grocery
list's Done section leaves recurring staples parked in the Recurring drawer, untouched, on
their normal 4-hour-after-`completed_at` clock — it does not retire them, and it does not
count them in the "cleared N items" undo toast.
