# Sunset reminders: design

**Date:** 2026-10-28
**Status:** shipped 2026-10-28 (release 1 `a48c90f`, release 2 `b6cdf95`)
**Background:** the spike in `docs/superpowers/notes/2026-10-15-reminders-deprecation.md`. Its
inventory was re-checked against HEAD `685eb83` on 2026-10-28.

## Decisions (owner, 2026-10-28)

1. **Ship it as one release.** That release removes the feature. A small follow-up release then
   deletes the leftover data. Only the owner uses reminders: all 159 reminder rows are theirs.
2. **Delete every reminders list.** There are three: the owner's "תזכורות" (10 open items), the
   owner's second list shared with one collaborator, and another user's empty list.
3. **Voice keeps time words in the item text.** "remind me to call mom at 9" adds the item
   "call mom at 9". Voice never sets a reminder.
4. **Delete the reminder history.** The `item_reminders` table is dropped in the follow-up release.

## What goes

- **The `reminders` list type:** the Reminders choice in the new-list picker and in list settings,
  the reminders list view with its Today, Tomorrow, This week and Later groups, and the date-sorted
  rows.
- **Timed reminders on items:** the bell button, ReminderSheet, TimePicker, the
  `@ncdai/react-wheel-picker` dependency, and the time and overdue labels on rows.
- **Reminder repeats:** the daily, weekly and monthly series that Done advances (`recurring.ts`,
  the `complete-recurring` route), and snooze.
- **Sending:** the reminder messages and the morning and evening digest from the bot, the
  `/api/cron/reminders` and `/api/cron/digest` routes, and the pg_cron jobs `process-reminders` and
  `reminder-digest`.
- **Voice reminders:** the `remind_at` and `recurrence` fields, and the date context in the prompt.
- **`users.timezone`:** only reminders read it. This covers the sync from the phone in
  TelegramProvider, the `timezone` field of PATCH `/api/user`, and the voice time-zone parameter.
- **Leftovers:** the three reminder diagnostic scripts in `scripts/`, the reminder locale keys in
  all three languages, the reminder CSS, and the reminder text in README.

## What stays

- **Grocery repeat items:** `items.recurring`, `recurring-respawn.ts`, RecurringItemsSection and the
  Repeat icon.
- **The Remind/Ready nudge in shared lists:** SignalSheet, `/api/lists/[id]/remind` and `ready`,
  `sendListReminder`, `reminderToast`, `items.reminderSent`, `items.signal.*` and
  `bot.listReminder`.
- **The Bell icon** in the list icon picker. The nudge uses it too.
- **The `cleanup-soft-deletes` cron job.**

Several of these share words like "remind" and "recurring" with reminders code. Removal decides by
what imports what, never by name.

## Release 1: the code, plus migration 028

### Migration `028_sunset_reminders.sql`

1. **Soft-delete the lists.** Run
   `UPDATE lists SET deleted_at = now() WHERE type = 'reminders' AND deleted_at IS NULL;`.
   - **Same as the app's own delete:** the app's DELETE only sets `lists.deleted_at`.
   - **Shared lists:** collaborators lose the list at once.
   - **Archived lists:** they're included, because they have the same type.
   - **Later:** `cleanup-soft-deletes` hard-deletes these lists 30 days later, together with their
     items.
2. **Stop the two cron jobs.** Use the filtered form inside a `DO` block, guarded by a check that
   pg_cron exists:
   `PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('process-reminders','reminder-digest');`.
   A bare `cron.unschedule('name')` raises an error when the job is missing, and that error would
   fail the deploy.
3. **Keep it safe to re-run.** The file must have no `BEGIN`/`COMMIT`. `migrate.mjs` runs each file
   as one transaction and records it in a separate step, so a file can run twice.

After the deploy, I check that only `cleanup-soft-deletes` is left: a read-only
`SELECT jobname FROM cron.job`.

### Server

- **Delete these routes:**
  - `cron/reminders` and `cron/digest`
  - `items/[itemId]/reminder` and `items/[itemId]/reminder/[reminderId]`
  - `items/[itemId]/complete-recurring`
  - `lists/[id]/reminders`
- **Delete these modules:**
  - `src/services/recurring.ts`
  - `src/utils/reminder-suppression.ts`
  - `src/schemas/reminders.ts`
- **PATCH `/items`:** delete the reminder hand-off on completion (`isPureCompletion`). This changes
  every list: a tick no longer reads reminders, which saves 2-3 queries.
- **Unmark-completed:** delete the reminders-list guard.
- **Clear-completed and DELETE `/items`:** remove the comments about reminders.
- **List type:** narrow to `["regular","grocery"]` in the zod schemas and the TypeScript types. Every
  reminders list is deleted, so no live row has the old value. A straggler made by an old app
  during the deploy shows as a regular list until release 2 deletes it.
- **Bot:**
  - **Delete:** `sendItemReminder`, `sendReminderDigest`, and the three `reminder_*` callback
    branches.
  - **Add one catch-all for any button starting with `reminder_`.** It answers
    "Reminders have been removed from the app" (new key `bot.remindersRemoved` in en, he and ru,
    written natively) and removes all the message's buttons. Their Open List button would open a
    deleted list.
  - **It writes nothing.** It reads only the user's language.
  - **Without it, old buttons would spin:** the callback chain has no final `else`.
- **Voice:**
  - **Remove:** the reminder insert in `voice-handler.ts`, and `remind_at`, `recurrence` and their
    parsing from `voice-processor.ts`.
  - **Change the prompt rule:** drop command words like "remind me to" and "add", and keep any time
    or date words in the item text.
  - **Remove the date context:** the "Now / TZ" prompt context and the `timezone` parameter, so
    `users.timezone` is no longer read.
- **`/api/user`:** PATCH stops accepting `timezone`. The schema then requires `language`.

### Client

- **Delete:** `ReminderSheet.tsx`, `TimePicker.tsx`, and the wheel-picker dependency.
- **List page:** delete `isReminders`, ReminderItemsList, `groupByDate`, the ReminderSheet mount and
  the auto-open effect. Unwrap the reminders/regular ternary without changing how grocery groups
  are laid out.
- **Pickers:** remove the Reminders choice from the home-page picker and the settings picker.
- **Item rows:** in ItemRow, SortableItem and CompletedItemsSection, remove the bell, the time label
  and overdue, and their props.
- **Data:** in `useListData`, delete both `/reminders` fetches, the `Reminder` type and the
  `my_reminder_*` fields.
- **Handlers:** in `useItemHandlers`, delete the reminder handlers and the "Done advances the
  series" path, including its `complete-recurring` call.
- **Offline replay:** remove the same `complete-recurring` path from `executor-factory.ts` in the
  same commit. Otherwise the parity test goes red, and offline replay must match the online path.
- **Search and add box:** search-while-typing no longer needs a reminders exception, and the add
  box always shows the normal placeholder.
- **TelegramProvider:** delete both time-zone sync blocks. This also removes their empty catches.
- **Styles:** remove `.bell-pulse` and `.time-picker*` from `globals.css`.
- **Locales:** remove the reminder keys from en, he and ru together, and keep every nudge key.

### Old app versions during the deploy (accepted with the single release)

- **The old code keeps serving for a few minutes** after migration 028 runs, because migrations run
  before the build. Reminders are already off by then: the lists are deleted and the crons stopped.
- **Queued offline actions for removed routes fail.** For example, a reminder Done tapped offline
  gets a 404, and the queue drops it.
- **An old app could still create a reminders list in that window.** Release 2 catches it.
- **If the build fails after the migration ran,** the old code runs with reminders already off.
  That's harmless.
- **The work stays on a local branch and is merged to main locally.** The branch is never pushed,
  because a Vercel preview build could run migrations on production.

## Release 2: migration 029 only

I push it once release 1's production deploy has succeeded, as GitHub reports for that commit.

1. **Catch stragglers.** Soft-delete any reminders list created during release 1's deploy window.
2. **Retire the type.** Set `type = 'regular'` on every `reminders` row (all of them deleted), then
   add `CHECK (type IN ('regular','grocery'))`.
3. **Delete the data.** Run `DROP TABLE item_reminders;` and
   `ALTER TABLE users DROP COLUMN timezone;`.

These can't go in release 1. During release 1's deploy the old code is still live, and it reads
both the table and the column.

## Testing

- **Delete 9 test files (about 90 tests) that only test reminders.** The bot reminder callbacks,
  repeat claiming, completion, suppression, snooze, delete-undo, and the unmark gate.
- **Trim the mixed test files:**
  - executor-factory and mutation-request-parity
  - voice-processor and voice-processor-sdk
  - list-type-switch and grouped-list-wiring
  - search-completed-items and clear-completed
  - list-data-categories and restore-skipped-flow
- **New tests, each seen red first:**
  - **Bot:** the catch-all answers with the new key, strips all buttons, and makes no database
    writes. It works for `reminder_done:`, `reminder_snooze:` and the snooze-option buttons.
  - **Voice:** the prompt keeps time words and drops command words, the response schema has no
    `remind_at`/`recurrence`, and the parser ignores a stray `remind_at`.
  - **Migration 028:** uses the filtered unschedule, contains no bare `cron.unschedule('...')`, and
    soft-deletes only `type = 'reminders'` rows.
  - **Migration 029:** same unschedule check, plus the CHECK constraint and the drops.
- **Gate:** `npx vitest run`, `npx tsc --noEmit`, `npx eslint`, and `npx next build` (never
  `npm run build`).
- **Review:** an independent review of the whole branch before merging.

## Manual steps for the owner (optional)

- **Vercel:** delete the `CRON_SECRET` environment variable. Nothing reads it after release 1.
- **Supabase Vault:** delete the `app_url` and `cron_secret` secrets. They're harmless if left.
- **BotFather:** I'll read the bot's description through the Bot API. If it mentions reminders, I'll
  give you new text to paste.

## After it ships

- **Docs and memory:** delete the parked spike note and update README and memory. That includes the
  search-while-typing note "off in reminders lists".
- **Lint:** the reminder-only lint problems disappear with the deleted code, including the two on
  the list page. The only one left is the pre-existing error in the login callback, which stays.

## Non-goals

- **No change** to the Remind/Ready nudge or to grocery repeat items.
- **No fix for the DST drift.** It goes away with the feature.
- **No new list type replaces reminders,** and no export beyond the list already given to the owner.
