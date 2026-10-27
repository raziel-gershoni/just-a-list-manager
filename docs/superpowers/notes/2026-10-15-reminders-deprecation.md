# Reminders deprecation: switch off vs remove

**Status:** parked (2026-10-15). Nothing is built. This holds the findings for when we pick it up.
Line numbers are as of `dd6291f` and will drift.

## The question

Reminders will be deprecated. How easy is it to switch them off and keep the code, compared with
removing them?

"Reminders" covers the `reminders` list type, timed item reminders (`item_reminders`, ReminderSheet,
the bell), their repeats and snooze, the bot messages with Done and Snooze buttons, the per-minute
delivery cron and the hourly digest.

Two things are **not** reminders and must keep working:
- **Grocery repeat items:** `items.recurring`, `recurring-respawn.ts`, RecurringItemsSection.
- **The Remind/Ready nudge in SignalSheet:** `POST /api/lists/[id]/remind`, `sendListReminder`.

## Answer

| | Switch off (A) | Remove (B) |
|---|---|---|
| Size | ~19 files, ~160 lines, 1 migration | ~60 files (23 deleted), ~4,300 lines, 2 migrations |
| Effort | a few hours with tests | about a day |
| Undo | flip one constant, reschedule the crons | git revert, reschedule; the list conversion is one-way |

**Recommended: staged (C).** Ship A now. When the deprecation is final, delete the gated code in one
PR with no behaviour change. Drop `item_reminders`, if ever, in a third deploy after a backup.
Leave at least 24 hours between A and B, because queued offline mutations live 24 hours
(`useMutationQueue.ts:18`).

## Option A: switch off

Every gate reads one code constant, `src/lib/features.ts`: `export const REMINDERS_ENABLED = false;`.
It is a constant, not an env var: the codebase has no flag convention and the client needs it too.

1. **Sending.** Add `if (!REMINDERS_ENABLED) return NextResponse.json({ disabled: true });` right after
   the CRON_SECRET check in `app/api/cron/reminders/route.ts` (~line 12) and
   `app/api/cron/digest/route.ts` (~line 9). This alone stops every message, with no migration.
2. **Repeats.** In `src/services/recurring.ts` `completeRecurringItem`, return
   `{ status: "already-completed" }` right after the claim succeeds (~line 83). This stops successors
   on all three paths:
   - PATCH `/items`
   - `complete-recurring`
   - bot Done

   It works because every caller treats `already-completed` as success, and no 4xx reaches the
   offline queue (which would drop it).
3. **Old Telegram buttons.** At the top of `handleCallbackQuery` in `src/services/bot.ts`, catch
   `reminder_snooze:`. Answer with a new `bot.remindersRetired` key in all three locales.
   - **Language:** `lang` is not in scope at the top of the function, so resolve it inside the guard,
     either from `query.from.language_code` or by looking up `users.language`.
   - **Keyboard:** keep the Open List web_app row and strip the other buttons. An empty
     `inline_keyboard` would remove Open List too.

   Done keeps working: it just ticks the item off.
4. **Creating.**
   - **List type schema:** add a writable list-type enum `["regular","grocery"]` in
     `src/schemas/lists.ts` for create and update. Reads keep the full enum. No DB change is needed,
     because migration 020 has no CHECK.
   - **List type pickers:** remove the Reminders button in `app/page.tsx` (~702-709) and the
     settings picker option in `app/list/[id]/page.tsx` (~410). The picker swallows a 400, so this
     step is required.
   - **List page:** gate `isReminders` with the flag (`page.tsx:55`).
   - **Reminder POST:** `.../items/[itemId]/reminder` POST returns 410 when off. Only stale WebViews
     can reach it.
5. **Client data.** Skip both `/reminders` fetches in `src/hooks/useListData.ts` (~117-131, ~199-213).
   `my_reminder_*` then stays null, so the recurring-done path and the done-row time labels go quiet.
6. **Voice.**
   - **Gate:** `src/services/voice-handler.ts:293` inserts reminders on any list type, so gate it.
   - **Prompt:** in `voice-processor.ts:143-144`, replace the reminder rule with "keep time words in
     the item text; always set remind_at and recurrence to null".
   - **Keep:** don't delete line 143's "Each item = separate entry" rule.
7. **Tests.**
   - **Mocks:** `list-type-switch.test.ts:153` should use `"regular"`. Add a
     `vi.mock("@/src/lib/features")` with the flag on to `recurring-claim` and
     `complete-item-recurrence` (import `vi`).
   - **New tests:** flag-off tests for the claim gate, the schema split, the bot guard and the cron
     early return. Delete each guard and confirm red.
   - **Re-anchor:** if `unmark-completed/route.ts:36` changes, re-anchor
     `unmark-completed-gate.test.ts:27`, which would otherwise pass vacuously.

**Second deploy, after A is live:** migration
`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('process-reminders','reminder-digest');`.
- **Use the filtered form.** A bare `cron.unschedule('name')` errors on a missing job and fails the
  build.
- **Leave `cleanup-soft-deletes` alone.**
- **Check it worked.** cron.job has row-level security, so the filtered form can silently match
  nothing. Afterwards run `SELECT jobname, active FROM cron.job` in the Supabase SQL editor.

**Optional one-way extras** (only if it's permanent):
- **Convert the lists:**
  `UPDATE lists SET type='regular', icon=COALESCE(icon,'Bell'), color=COALESCE(color,'blue') WHERE type='reminders';`
  The updated_at trigger then lifts these lists to the top of unreordered home screens. Wrap the
  UPDATE in `ALTER TABLE lists DISABLE/ENABLE TRIGGER trg_lists_updated_at` to avoid that.
- **Cancel unsent reminders:**
  `UPDATE item_reminders SET cancelled_at=now() WHERE sent_at IS NULL AND cancelled_at IS NULL;`
- **Close direct writes:** `DROP POLICY IF EXISTS "Users can manage their own reminders" ON item_reminders;`
  It is the only client-writable policy. No client code reads the table.

## Option B: remove (stage 2)

**Delete:**
- **Source:**
  - cron routes: `reminders`, `digest`
  - `reminder-suppression.ts`
  - `src/services/recurring.ts`
  - `src/schemas/reminders.ts`
  - item routes: `reminder/route.ts`, `reminder/[reminderId]/route.ts`, `complete-recurring/route.ts`
  - list route: `lists/[id]/reminders/route.ts`
  - components: `ReminderSheet.tsx`, `TimePicker.tsx` (only ReminderSheet imports it)
- **Tests:**
  - bot and auth: `bot-reminder-done-failure`, `reminder-callback-auth`, `reminder-list-binding`
  - delivery: `reminder-suppression`
  - repeats: `snooze-keeps-recurrence`, `recurring-claim`, `complete-item-recurrence`
  - others: `delete-undo-reminders`, `unmark-completed-gate`

  These are 9 files, about 90 tests.
- **Scripts:** the three reminder diagnostic scripts in `scripts/`.

**Edit:**
- **Bot:** `bot.ts`
  - **Delete:** the reminder branches, `sendItemReminder`, `sendReminderDigest`, and the now-unused
    imports at lines 9-10.
  - **Add:** a `reminder_` catch-all that answers and strips the buttons. The chain has no final
    else, so old buttons would otherwise spin.
- **Items route:** `app/api/lists/[id]/items/route.ts`
  - **Delete:** the `isPureCompletion` hand-off.
  - **Keep:** the grocery recurring/restore block.
- **Offline replay:** delete the recurring toggle from `executor-factory.ts` and `useItemHandlers.ts`
  in the **same commit**, to keep the parity test green. Also delete the reminder handlers.
  - **Keep:** `sendSignal`, `handleRemind/handleReady`, `setReminderToast`.
- **Client data:** in `useListData.ts` and `src/types/items.ts`, delete the Reminder type, the
  fetches and the `my_reminder_*` fields. Narrow the `ListType` unions.
- **List page:** in `app/list/[id]/page.tsx`, delete `isReminders`, ReminderItemsList, `groupByDate`
  and the ReminderSheet mount.
  - **Keep:** `reminderToast` and SignalSheet.
- **Item row props:** in ItemRow, SortableItem and CompletedItemsSection, delete the props
  `reminderAt`, `recurrence`, `onReminderTap` and `isOverdue`.
  - **Keep:** the grocery Repeat icon.
- **Small client edits:**
  - **AddItemInput:** always show the normal placeholder.
  - **search-completed-items:** drop the reminders opt-out.
  - **list-icons:** narrow the type; keep `Bell` and `blue` in the pickers.
- **Voice:** delete the voice-handler reminder block and the voice-processor
  `remind_at`/`recurrence` fields, parser and prompt rule.
  - **Keep:** both `recycleItem` calls, the "separate entry" rule and the TZ/now context (tested at
    `voice-processor.test.ts:102-103`).
- **Unmark/clear routes:** delete the reminders gate in `unmark-completed`. In `clear-completed`,
  change comments only, and keep `.eq("recurring", false)`.
- **Styles and deps:**
  - **globals.css:** delete `.bell-pulse` and `.time-picker*`.
  - **Wheel picker:** run `npm uninstall @ncdai/react-wheel-picker` so the lockfile changes too.
  - **README:** lines 17, 24, 28, 36, 44, 52, 120 and the CRON_SECRET row.
- **Locales (all three together):**
  - **Delete:**
    - the `reminder.*` namespace and `lists.typeReminders`
    - the reminder `items.*` keys: placeholder, overdue, the date-group keys, `tom`, and the dead
      `todayEvening`/`tomorrowMorning`/`custom`
    - `settings.reminders*`
    - the reminder/digest `bot.*` keys, plus `bot.openApp`, whose only user is the digest
  - **Keep:**
    - `items.reminderSent`, `items.signal.*` (the nudge)
    - `bot.listReminder`, `bot.openList`
    - `items.recurring.*` (grocery)

**Migrations:**
- **Unschedule the crons:** if A's migration hasn't run, unschedule them here.
- **Convert the lists:** if stage 1 skipped it, convert reminders lists here.
- **Keep `item_reminders`:** never drop it in the same deploy, because old code still serving
  queries it on every tick.

## Traps the review found

- **Migrations run before the build.** `npm run build` is `node scripts/migrate.mjs && next build`.
  A type error after a migration leaves the DB change live under old code. So ship code first and
  migrations later, and run `npx tsc --noEmit` before pushing (vitest does not type-check).
- **"Recurring" means two things.** Delete by import graph, not by name.
- **Shared names belong to the nudge.** `reminderToast`, `setReminderToast` and `items.reminderSent`
  belong to the Remind nudge.
- **Every tick queries reminders.** PATCH `/items` queries `item_reminders` on every checkbox tick on
  every list.
- **Stale clients.** A stale WebView can POST to a deleted `complete-recurring` route, and the queue
  drops the 404. Staging (A first, then wait 24h or more) removes this.
- **Vercel Preview builds.** If they have `DATABASE_URL`, pushing a branch applies its migrations to
  production.

## Known bug, left unfixed on purpose (2026-10-27)

Repeating reminders drift an hour at every clock change. `getNextOccurrence` in
`src/services/recurring.ts` adds days, weeks and months on the server's UTC clock, so the UTC time
stays fixed. After Israel left summer time on 2026-10-25, every waiting repeating reminder fires an
hour early (07:30 became 06:30). They jump back on 2027-03-26.

The owner decided not to fix it, because reminders are being sunset. If they stay after all:
- **Code:** step in the owner's `users.timezone` (`date-fns` + `@date-fns/tz`; Vercel's Node 24 has no
  `Temporal`).
- **Data:** in the same deploy, move the waiting rows back to their pre-switch local time. A
  zone-aware fix keeps the current local time, so it would lock in the early time.
- **Same mistake:**
  - **Snooze:** "Tomorrow" in `bot.ts`.
  - **Voice:** Gemini has to work out the offset from UTC itself.
  - **Digest:** the day range on the evening before a change.
  - **Monthly repeats:** the 29th-31st slide to another day.

## Open questions for the owner

1. Pause or permanent? A pause skips the one-way extras.
2. Old Telegram reminders: Done keeps ticking the item, and Snooze says "no longer available" and
   strips itself. OK?
3. Voice "remind me to call mom at 9": add "call mom at 9" (keep the time words)?
4. Ever drop `item_reminders`, or keep it as history?
5. Outside the repo: the BotFather description and any listing may advertise reminders.

Baseline when written: 65 test files, 545 tests, green.
