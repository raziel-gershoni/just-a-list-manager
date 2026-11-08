# "Not needed this week" for recurring grocery items

**Date:** 2026-11-07
**Status:** owner's decisions taken (2026-11-07); ready to build.

## Owner's decisions

1. **Where:** a fifth icon on the row, shown only on recurring items in grocery lists. The owner chose this
   over a sheet behind the repeat icon, knowing the text column gets narrower on small phones.
   Superseded 2026-11-08: the action moved into the item sheet
   (2026-11-08-item-sheet-and-quantity-design.md).
2. **How long:** until the week ends. The item comes back at Saturday midnight, the start of
   Sunday on the tapper's phone (an Israeli week, Sunday to Saturday). Tap it on Thursday and it's back
   two days later. Tap it on Saturday evening and it's back at midnight.
3. **Defaults the owner was shown and didn't object to:**
   - Recurring items only.
   - While away, the item waits in the Recurring section.
   - Tapping it there brings it back now.
   - Adding the same item again (typed, a suggestion tap, or voice) brings the waiting item back
     instead of creating a duplicate.

## The problem

"Not available" hides an item for 4 hours, because the store didn't have it. A recurring staple that
is still needed comes back 4 hours after it's ticked. The household has no way to say "we have enough
milk, don't bring it this week". Ticking it brings it back in 4 hours. Stopping repeating loses the staple.

## Design

### Model: a paused item is parked, with a later return time

A recurring item that is ticked is already "parked": `recurring && completed && !deleted_at`. It waits
in the Recurring section and comes back 4 hours after `completed_at`
(`src/utils/recurring-respawn.ts`). "Not needed this week" parks it the same way and stores when it
comes back:

- New column `items.paused_until TIMESTAMPTZ` (migration `031_item_paused_until.sql`, nullable, no
  index, since nothing on the server filters on it).
- **Pause** sets:
  - `completed = true`
  - `completed_at = tap time`
  - `paused_until = the week's end`
  - `skipped_at = null` and `ordered_at = null`, since the item leaves the active list.
- **Return time** (one function, `respawnAt`):
  - Not recurring, deleted, or no `completed_at`: never.
  - Otherwise `paused_until` if set, else `completed_at + 4h`.
  - `shouldRespawn` is `now > respawnAt`. This keeps today's strict 4-hour boundary.
- Because a paused item is parked, everything already built for parked staples just works:
  - The Recurring section lists it.
  - It is out of the active list, drag order, category groups and the duplicate-add warning.
  - Home card counts leave it out (migration 030: in neither `active_count` nor `completed_count`).
  - Clear completed and Unmark all skip it (they exclude recurring rows).
  - Respawn on list load queues `restore-recurring` through the sync engine.
  - A typed add, a suggestion tap or voice recycles it.

**Caveat:** `completed = true` on a paused row does not mean "bought". Nothing in the app reads
`completed` as "bought" today (no stats, no Telegram text). A future feature that does must look at
`paused_until`.

### Week end

`weekEnd(now) = startOfWeek(addWeeks(now, 1), { weekStartsOn: 0 })` (date-fns, device local time,
DST-aware). It's the next Sunday 00:00, always after `now`. Tapped exactly at Sunday 00:00, it's the
following Sunday. The client computes it, because the server has no time zone (reminders and
`users.timezone` were removed). `WEEK_STARTS_ON = 0` is a named constant beside it.

### Every path that leaves the paused state clears `paused_until`

| Path | Server | Client optimistic | Engine `FIELDS` gains `paused_until` |
|---|---|---|---|
| Pause (new `pause` change) | PATCH `pausedUntil` branch | yes | new entry: `completed, completed_at, paused_until, skipped_at, ordered_at` |
| Tick / untick (`toggle`) | `completed` branch sets `paused_until = null` | `handleToggle` sets `null` | `toggle` |
| Bring back now / auto-return (`restore-recurring`) | `restoreRecurring` branch | `handleRestoreRecurring` and the respawn in `useListData` set `null` | `restore-recurring` |
| Stop repeating (`set-recurring` false) | `recurring === false` sets `null` | `handleSetRecurring(false)` sets `null` | `set-recurring` |
| Typed add, suggestion or voice recycle | `item-recycler` update sets `null` | `recycleCompleted` sets `null` | none: `recycle` owns the whole row |

Every optimistic row sets `paused_until` explicitly, `null` included. `overlayPending` only keeps a
pending field the on-screen row carries (`field in mine`).

Skip and On the way can't reach a paused row, which is completed and not in the active list, so their
branches stay as they are.

### Server (PATCH `/api/lists/[id]/items`)

- `updateItemSchema` gains `pausedUntil: z.string().max(64).optional()`. Its presence means "pause".
- **`pauseEnd(raw, stamp)`:**
  - It parses `raw` and clamps it to `[stamp, stamp + 7 days + 1 hour]`. A local week is at most
    7 days plus the hour a DST change adds.
  - Unparseable falls back to `stamp + 7 days`, with a `console.warn`.
  - It never returns a 400, because the offline queue drops a 4xx and the user's tap with it (the same
    rule as `tapTime`).
  - `stamp` is `tapTime(at)`.
- **The pause branch** writes the five fields above. The update gains `.eq("recurring", true)`, so a
  pause that arrives after a collaborator stopped the repeat writes nothing. It answers the existing
  404 "Item not found" and leaves the row as it is.
- **GET** selects `paused_until`. The select list is explicit, guarded by `items-get-columns.test.ts`.
- The order of the PATCH branches keeps the pause last among `completed`-writing branches. A request
  carries one action, but if it ever carries two, the pause wins over its own `completed = true`.

### Client

- **`ItemData`:** add `paused_until?: string | null`.
- **`handlePause(itemId)` in `useItemHandlers`:**
  - It builds `at` and `pausedUntil = weekEnd(new Date())`.
  - The optimistic update uses `sameItem(itemId)`.
  - It queues `addMutation({ type: "pause", payload: { listId, itemId, pausedUntil, at } })`.
- **`executor-factory`** gains a `case "pause"`: PATCH `{ itemId, pausedUntil, at: tapTime(mutation) }`,
  `keepalive`, and it throws `Pause failed: <status>` when not ok. Guarded by
  `single-executor.test.ts`, `executor-factory.test.ts` (`REPLAYABLE_TYPES`) and
  `mutation-request-parity.test.ts` (`SAMPLES`).
- **Engine `FIELDS`:** as in the table.
- **`useListDerivedData`:** the Recurring section is sorted by `respawnAt`, soonest first, so paused items
  sort after the ones that were bought.

### UI

- **`ItemRow`:**
  - New props `onPause?: (id: string) => void`.
  - A button shown when `onPause && recurring && !completed`, placed after On the way and before Repeat
    (the owner's chosen layout: ⊘ 🚚 [new] ⟳ ✕).
  - Lucide `CalendarOff`, 18px, `text-tg-hint`, the same markup, haptic (`light`) and `active:scale-90`
    as the On the way button.
  - `aria-label` is `items.recurring.notThisWeek`.
- **`SortableItem`** passes the prop through.
- **The list page** passes `onPause={handlePause}` in the grouped map (grocery only) and
  `listType === "grocery" ? handlePause : undefined` in the ungrouped map.
- **`RecurringItemsSection`, paused rows** (`paused_until != null`):
  - Not struck through: the item wasn't bought.
  - The leading control is the restore button, aria-label `items.recurring.restore` ("Add back to
    list"). It shows the `CalendarOff` glyph in the app's on-state recipe (`text-tg-link` with a bold
    stroke) instead of a filled tick.
  - The caption is `items.recurring.notThisWeek`. Once the return time has passed (the app stayed open
    over midnight), it shows `returningSoon`, like a bought item past its 4 hours.
  - The Repeat button is unchanged ("Stop recurring").
- **Copy:** one new key `items.recurring.notThisWeek`, used for the button and the caption:
  - en "Not needed this week"
  - he "לא צריך השבוע"
  - ru "На этой неделе не нужно"

### Inverse cases

- **Bring back early:** the restore button in the Recurring section (`restore-recurring`). The item returns
  to the top of the active list with no pause.
- **Stop repeating a paused item:** it becomes an ordinary ticked item under Completed, the same as stopping
  a bought, parked staple today. The pause is cleared.
- **Pause, then a collaborator stops the repeat before the pause lands:** the server writes nothing (404).
  The next refresh or echo shows the collaborator's version.
- **A stale auto-return:** a paused item whose week has ended comes back on the next list load, as a bought
  staple does after 4 hours. An app left open over midnight shows "Returning soon" until the next load.
  That limit already exists.
- **Offline:** the pause is queued and replayed with its tap time. A replay after the week ended still
  parks it, and the next load brings it back. The queue's 24-hour limit drops older entries, as for
  every other change.
- **View-only collaborators:** no change. No row button is hidden for them today. The server refuses
  with 403, and the engine shows its sync error.

## Non-goals

- No pause for non-recurring items. For a one-off, "not needed" means delete it.
- No choice of duration and no per-list or per-user week-start setting.
- No undo toast, matching Not available. The way back is the Recurring section.
- No server-side respawn job. Returning stays client-side, as for the 4-hour rule.
- No change to how existing rows look or how wide they are.

## Tests

- **`recurring-respawn.test.ts`:**
  - Paused, future: no return, even past 4 hours.
  - Paused, past: returns.
  - Exactly at `paused_until`: no return (strict `>`).
  - The 4-hour path and the deleted-row rules are unchanged.
  - `weekEnd` on each weekday, at Sunday 00:00 exactly, and across the Israel DST change, with
    `TZ=Asia/Jerusalem`.
- **`items-patch-tap-time.test.ts` (or a sibling over `fakeItemsTable`):**
  - The pause writes the five fields.
  - Clamping: past, too far ahead, and unparseable.
  - A non-recurring row is untouched (404).
  - Toggle, restore, `recurring` false and recycle each clear `paused_until`.
- **`items-get-columns.test.ts`:** `paused_until` is selected.
- **Engine and sync:**
  - `sync-engine.test.ts` `pendingFields` covers `pause` and the new fields on `toggle`, `restore-recurring`
    and `set-recurring`.
  - A refresh or an echo does not undo a pending pause or restore.
  - Executor body and failure.
  - Request parity.
- **`item-recycler.test.ts`:** the recycle update clears `paused_until`.
- **`item-sections.test.ts`:** a paused item is parked, not active or skipped.
- **UI:**
  - Rendered `ItemRow`: the button shows only on recurring, non-completed rows that have `onPause`.
  - Rendered `RecurringItemsSection`: a paused row isn't struck through and has its caption.
  - Wiring: both list-page maps pass `onPause`.
  - Locale parity.
- **Bite checks:** every guard (each clear, each `FIELDS` entry, the `recurring` filter, the clamp) is
  removed once and the test goes red.
