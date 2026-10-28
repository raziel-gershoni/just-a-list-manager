# Sunset Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the reminders feature completely: one release with the code and migration 028, then a second release with migration 029, which drops the leftover data.

**Architecture:**
- **Order:** delete from the outside in. First the database switch-off (028), then the bot and delivery crons, the server API, voice, the client UI, the client data layer and offline replay, the list type, the time zone, the locales and the leftovers. Migration 029 comes last.
- **Every task leaves the gate green.** Code is removed only once nothing uses it any more.
- **Migration 029 is pushed separately,** after release 1's production deploy succeeds. During release 1's deploy the old code still reads `item_reminders` and `users.timezone`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Postgres + pg_cron, node-telegram-bot-api, next-intl (en/he/ru), Vitest (node), `@google/genai` voice.

**Spec:** `docs/superpowers/specs/2026-10-28-sunset-reminders-design.md`

## Global Constraints

- **Never run `npm run build`.** It runs `scripts/migrate.mjs` against the production `DATABASE_URL`. Use `npx tsc --noEmit && npx next build`.
- **Work on the local branch `sunset-reminders` and never push it.** A Vercel preview build of a pushed branch could apply migrations to production. Merge to `main` locally.
- **Migrations:**
  - **Naming:** `supabase/migrations/NNN_snake_case.sql`. The next numbers are `028` and `029`.
  - **No transaction control:** never `BEGIN`/`COMMIT` in a file, and every file must be safe to re-run.
  - **pg_cron:** never a bare `cron.unschedule('name')`.
- **What stays:**
  - **Grocery repeat items:** `items.recurring`, `src/utils/recurring-respawn.ts`, RecurringItemsSection, the Repeat icon, the `set-recurring`/`restore-recurring` mutations.
  - **The Remind/Ready nudge:** SignalSheet, `/api/lists/[id]/remind`, `/api/lists/[id]/ready`, `sendListReminder`, `sendListReady`, `reminderToast`/`setReminderToast`, `items.reminderSent`, `items.signal.*`, `bot.listReminder`, `bot.openList`.
  - **The Bell icon** in `LIST_ICONS`.
  - **The `cleanup-soft-deletes` cron.**
- **Decide by what imports what, never by name.** "remind" and "recurring" collide with kept features.
- **Locales:** en, he and ru change together. Hebrew and Russian read as natively written. No inline user-facing strings.
- **No silent failures:** every caught error is logged.
- **Tests:**
  - **No live services:** tests never reach live services or the database.
  - **New tests:** each is seen red first, and its guard is deleted once to confirm it bites.
- **Gate after every task:** `npx vitest run`, `npx tsc --noEmit` and `npx eslint <touched files>`, all green.
- **Offline replay:** `useItemHandlers` and `src/utils/executor-factory.ts` change in the same commit (mutation-request-parity).
- **Commit trailers on every commit:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y`

## Review Focus

1. **An app opened before the deploy (old bundle) ticks an item on a grocery or regular list.** PATCH `/items` must still complete it, and no reminder code may run. T3's PATCH test pins the new route; the old bundle hits the same route.
2. **Offline mutations queued by the old bundle replay after the deploy.** A `toggle` carrying `remindAt`/`recurrence` must replay as a plain PATCH (T6 test). A `complete-recurring` POST gets a 404 and is dropped, which the spec accepts.
3. **`cron.job` is hidden by row-level security from the migrating role.** Then 028 unschedules 0 jobs and pg_cron keeps calling deleted routes every minute. The Finish section's read-only `SELECT jobname FROM cron.job` check catches this, and the `RAISE NOTICE` count shows in the build log.
4. **A Hebrew or Russian voice note** ("תזכיר לי להתקשר לאמא בתשע", "напомни мне позвонить маме в девять"). The prompt says to drop command words in any language and keep time words (T4 prompt test). The real model is not exercised in tests.
5. **A collaborator or home screen still holding a reminders list's id after the soft-delete.** For example, a stored home order, or a deep link from an old Telegram message. Both must behave as for any deleted list. Existing deleted-list handling covers it, and T2 strips the old buttons so the deep links go away.

---

### Task 0: Set up the branch

- [ ] **Step 1:** `git checkout main && git pull --ff-only && git checkout -b sunset-reminders`. Never push this branch.
- [ ] **Step 2:** `npm ci` if `node_modules` is missing, then `npx vitest run`. Expected baseline: 65 files and 550 tests, all passing.

---

### Task 1: Migration 028 soft-deletes reminders lists and stops the reminder cron jobs

**Files:**
- Create: `supabase/migrations/028_sunset_reminders.sql`
- Create: `__tests__/unit/migration-028-sunset-reminders.test.ts`

**Interfaces:**
- Consumes: none (only the existing tables `lists` (column `type`, `deleted_at`) and pg_cron's `cron.job` / `cron.unschedule(bigint)`).
- Produces: migration file `028_sunset_reminders.sql`. When it has run, no live `lists` row has `type = 'reminders'` and `deleted_at IS NULL`, and the pg_cron jobs `process-reminders` and `reminder-digest` are gone. `item_reminders`, `users.timezone` and `cleanup-soft-deletes` are left alone (T11 drops the first two).

- [ ] **Step 1: Write the failing source-inspection test.** Create `__tests__/unit/migration-028-sunset-reminders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Migration 028 runs on production before `next build` (scripts/migrate.mjs runs each
// file as one implicit transaction, then records it in a separate statement). Any statement
// that errors fails the whole deploy, and a file that ran but wasn't recorded runs again.
// These checks hold the properties docs/superpowers/specs/2026-10-28-sunset-reminders-design.md
// relies on.
const raw = readFileSync(
  resolve(process.cwd(), "supabase/migrations/028_sunset_reminders.sql"),
  "utf8"
);
// Comments may quote the forms forbidden below, so check only the SQL that runs.
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

describe("migration 028_sunset_reminders", () => {
  it("soft-deletes only reminders lists that are still live", () => {
    expect(sql).toMatch(
      /UPDATE\s+lists\s+SET\s+deleted_at\s*=\s*now\(\)\s+WHERE\s+type\s*=\s*'reminders'\s+AND\s+deleted_at\s+IS\s+NULL\s*;/i
    );
    const updates = sql.match(/\bUPDATE\b[\s\S]*?;/gi) ?? [];
    expect(updates, "028 must write nothing but the reminders-list soft-delete").toHaveLength(1);
  });

  it("unschedules both reminder jobs with the filtered form, inside a pg_cron guard", () => {
    expect(sql).toMatch(/DO\s+\$\$[\s\S]*END\s+\$\$\s*;/i);
    const guard = sql.search(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_extension\s+WHERE\s+extname\s*=\s*'pg_cron'\s*\)\s+THEN/i
    );
    const unschedule = sql.search(
      /PERFORM\s+cron\.unschedule\(\s*jobid\s*\)\s+FROM\s+cron\.job\s+WHERE\s+jobname\s+IN\s*\(\s*'process-reminders'\s*,\s*'reminder-digest'\s*\)\s*;/i
    );
    const endIf = sql.search(/END\s+IF\s*;/i);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(unschedule).toBeGreaterThan(guard);
    expect(endIf).toBeGreaterThan(unschedule);
  });

  it("never calls cron.unschedule by job name (it raises when the job is missing)", () => {
    expect(sql).not.toMatch(/cron\.unschedule\s*\(\s*'/i);
  });

  it("leaves the cleanup-soft-deletes job alone", () => {
    expect(sql).not.toContain("cleanup-soft-deletes");
  });

  it("drops or alters nothing the old code still reads during the deploy", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("has no transaction control of its own", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
    expect(sql).not.toMatch(/\bSTART\s+TRANSACTION\b/i);
  });
});
```

What turns each test red: (1) removing `AND deleted_at IS NULL` or the `type = 'reminders'` filter, or adding a second UPDATE (for example one that cancels `item_reminders` rows); (2) removing the `pg_extension` guard, moving the PERFORM outside it, or dropping either job name; (3) writing `cron.unschedule('process-reminders')`; (4) any SQL that names `cleanup-soft-deletes`; (5) adding `DROP TABLE item_reminders` or `ALTER TABLE users DROP COLUMN timezone` to this release; (6) wrapping the file in `BEGIN;` … `COMMIT;`.

- [ ] **Step 2: Run the test and confirm it fails.** Run `npx vitest run __tests__/unit/migration-028-sunset-reminders.test.ts`. Expected: the file fails before any test runs, with `ENOENT: no such file or directory, open '.../supabase/migrations/028_sunset_reminders.sql'`.

- [ ] **Step 3: Write the migration.** Create `supabase/migrations/028_sunset_reminders.sql`:

```sql
-- Sunset reminders, release 1 (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md).
-- Safe to re-run: scripts/migrate.mjs records a file in a separate step after running it, so
-- there is no BEGIN/COMMIT here and each statement does nothing the second time.
-- item_reminders and users.timezone stay until migration 029: the old code that keeps serving
-- during this deploy still reads both.

-- 1. Soft-delete every reminders list the way the app's own DELETE does (only lists.deleted_at).
--    Archived and shared lists are included. The cleanup-soft-deletes job hard-deletes them,
--    with their items, 30 days later.
UPDATE lists SET deleted_at = now() WHERE type = 'reminders' AND deleted_at IS NULL;

-- 2. Stop the two reminder cron jobs (016, 017). The filtered form removes only jobs that exist;
--    unscheduling by name raises an error for a missing job, and that would fail the deploy.
--    cron.job is row-level secured, so a role that cannot see the jobs removes none. The NOTICE
--    puts the count in the build log, and SELECT jobname FROM cron.job confirms it after deploy.
DO $$
DECLARE
  v_removed BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('process-reminders', 'reminder-digest');
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RAISE NOTICE '[028] unscheduled % reminder cron job(s)', v_removed;
  ELSE
    RAISE NOTICE '[028] pg_cron is not installed; no reminder cron jobs to unschedule';
  END IF;
END $$;
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `npx vitest run __tests__/unit/migration-028-sunset-reminders.test.ts`. Expected: 6 passed.

- [ ] **Step 5: Prove the tests bite.** In the SQL file, temporarily replace the line `PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('process-reminders', 'reminder-digest');` with `PERFORM cron.unschedule('process-reminders');`. Run `npx vitest run __tests__/unit/migration-028-sunset-reminders.test.ts`. Expected: 2 failed ("unschedules both reminder jobs…" and "never calls cron.unschedule by job name…"). Put the original line back. Then temporarily delete ` AND deleted_at IS NULL` from the UPDATE and run again. Expected: 1 failed ("soft-deletes only reminders lists that are still live"). Put it back and run again. Expected: 6 passed.

- [ ] **Step 6: Run the gate.** Run `npx vitest run`. Expected: all green, with 6 more tests than before this task. Run `npx tsc --noEmit`. Expected: no errors. Run `npx eslint __tests__/unit/migration-028-sunset-reminders.test.ts`. Expected: no problems. ESLint doesn't lint the `.sql` file.

- [ ] **Step 7: Commit.**

```bash
git add supabase/migrations/028_sunset_reminders.sql __tests__/unit/migration-028-sunset-reminders.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 028 soft-deletes reminders lists and stops their cron jobs

Soft-deletes every live type='reminders' list the way the app's DELETE does,
and unschedules process-reminders and reminder-digest with the filtered
cron.job form inside a pg_cron guard, so a missing job cannot fail the
deploy. Idempotent, no BEGIN/COMMIT. cleanup-soft-deletes, item_reminders
and users.timezone are untouched (029 drops the data).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 2: Bot catch-all for old reminder buttons, delete delivery crons

**Files:**
- Modify: `src/services/bot.ts`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (add `bot.remindersRemoved`)
- Create: `__tests__/unit/removed-reminder-buttons.test.ts`
- Delete: `app/api/cron/reminders/route.ts`, `app/api/cron/digest/route.ts`, `src/utils/reminder-suppression.ts`
- Delete: `__tests__/unit/bot-reminder-done-failure.test.ts`, `__tests__/unit/reminder-callback-auth.test.ts`, `__tests__/unit/reminder-list-binding.test.ts`, `__tests__/unit/snooze-keeps-recurrence.test.ts`, `__tests__/unit/reminder-suppression.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - The locale key `bot.remindersRemoved` in all three locales. T9 must keep it.
  - `handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void>` keeps its signature. Any `data` that starts with `"reminder_"` now gets an answer with that key, and all of the message's buttons are removed.
  - `sendItemReminder` and `sendReminderDigest` are removed from `src/services/bot.ts`. After this task `bot.ts` no longer imports `@/src/lib/api-auth` or `@/src/services/recurring`. `recurring.ts` still exists, and T3 deletes it.

- [ ] **Step 1: Write the failing behavioural test.** Create `__tests__/unit/removed-reminder-buttons.test.ts` with this content:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type TelegramBot from "node-telegram-bot-api";
import en from "@/messages/en.json";
import he from "@/messages/he.json";
import ru from "@/messages/ru.json";

// Runs the real handleCallbackQuery; the Telegram client, env and Supabase are faked.
// Reminders are gone, but old reminder messages still sit in users' chats and
// their Done / Snooze / snooze-option buttons keep posting reminder_* callbacks.
const h = vi.hoisted(() => ({
  userRow: { language: "he" } as { language: string | null } | null,
  userError: null as { message: string } | null,
  reads: [] as { table: string; columns: string; filters: string[] }[],
  writes: [] as { table: string; op: string }[],
  answers: [] as { id: string; options: unknown }[],
  markupEdits: [] as { markup: unknown; options: unknown }[],
  textEdits: [] as { text: string; options: unknown }[],
  sends: [] as { chatId: number; text: string }[],
  answerError: null as Error | null,
  markupError: null as Error | null,
}));

interface SelectChain {
  eq(column: string, value: unknown): SelectChain;
  single(): Promise<{ data: unknown; error: unknown }>;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ TELEGRAM_BOT_TOKEN: "test-token", NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

vi.mock("node-telegram-bot-api", () => ({
  default: class FakeTelegramBot {
    onText(): void {
      // bot.ts registers /start and /help here; not exercised by these tests.
    }
    async answerCallbackQuery(id: string, options?: unknown) {
      h.answers.push({ id, options });
      if (h.answerError) throw h.answerError;
      return true;
    }
    async editMessageReplyMarkup(markup: unknown, options?: unknown) {
      h.markupEdits.push({ markup, options });
      if (h.markupError) throw h.markupError;
      return true;
    }
    async editMessageText(text: string, options?: unknown) {
      h.textEdits.push({ text, options });
      return true;
    }
    async sendMessage(chatId: number, text: string) {
      h.sends.push({ chatId, text });
      return {};
    }
  },
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: (table: string) => {
      // Any write fails the test: it is recorded AND throws, so a write wrapped
      // in try/catch still shows up in h.writes.
      const refuseWrite = (op: string) => () => {
        h.writes.push({ table, op });
        throw new Error(`unexpected ${op} on ${table}`);
      };
      return {
        select: (columns: string): SelectChain => {
          const rec = { table, columns, filters: [] as string[] };
          h.reads.push(rec);
          const result = async () =>
            table === "users"
              ? { data: h.userRow, error: h.userError }
              : { data: null, error: null };
          const chain: SelectChain = {
            eq: (column, value) => {
              rec.filters.push(`eq:${column}=${value}`);
              return chain;
            },
            single: result,
            maybeSingle: result,
          };
          return chain;
        },
        insert: refuseWrite("insert"),
        update: refuseWrite("update"),
        upsert: refuseWrite("upsert"),
        delete: refuseWrite("delete"),
      };
    },
    rpc: (fn: string) => {
      h.writes.push({ table: fn, op: "rpc" });
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

import { handleCallbackQuery } from "@/src/services/bot";

const CHAT_ID = 555;
const MESSAGE_ID = 42;
const TELEGRAM_USER_ID = 777;

const STRIPPED = {
  markup: { inline_keyboard: [] },
  options: { chat_id: CHAT_ID, message_id: MESSAGE_ID },
};

function tap(data: string, withMessage = true): TelegramBot.CallbackQuery {
  return {
    id: "cb-1",
    from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: "Dana" },
    chat_instance: "ci-1",
    data,
    ...(withMessage
      ? {
          message: {
            message_id: MESSAGE_ID,
            date: 0,
            chat: { id: CHAT_ID, type: "private" as const },
            // The keyboard an old reminder message was sent with.
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Done", callback_data: "reminder_done:r1" },
                  { text: "Snooze", callback_data: "reminder_snooze:r1" },
                ],
                [{ text: "Open List", web_app: { url: "https://app.test/list/list-1" } }],
              ],
            },
          },
        }
      : {}),
  };
}

beforeEach(() => {
  h.userRow = { language: "he" };
  h.userError = null;
  h.reads = [];
  h.writes = [];
  h.answers = [];
  h.markupEdits = [];
  h.textEdits = [];
  h.sends = [];
  h.answerError = null;
  h.markupError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCallbackQuery: buttons on old reminder messages", () => {
  it.each([
    ["Done", "reminder_done:r1"],
    ["Snooze", "reminder_snooze:r1"],
    ["a snooze option (30m)", "reminder_snooze:r1:30m"],
    ["a snooze option (tomorrow)", "reminder_snooze:r1:tomorrow"],
  ])("%s answers in the user's language, strips every button and writes nothing", async (_label, data) => {
    await handleCallbackQuery(tap(data));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.remindersRemoved } }]);
    // All buttons go, Open List included: it would open a deleted list.
    expect(h.markupEdits).toEqual([STRIPPED]);
    expect(h.writes).toEqual([]);
    // Only the user's language is read; nothing about the reminder or its list.
    expect(h.reads).toEqual([
      { table: "users", columns: "language", filters: [`eq:telegram_id=${TELEGRAM_USER_ID}`] },
    ]);
    expect(h.textEdits).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it.each([
    ["en", en.bot.remindersRemoved],
    ["ru", ru.bot.remindersRemoved],
  ])("answers a user whose language is %s in that language", async (language, text) => {
    h.userRow = { language };

    await handleCallbackQuery(tap("reminder_done:r1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text } }]);
  });

  it("falls back to English for a Telegram user the app doesn't know", async () => {
    h.userRow = null;

    await handleCallbackQuery(tap("reminder_done:r1"));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: en.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("logs a failed language lookup and still answers in English", async () => {
    h.userRow = null;
    h.userError = { message: "db down" };

    await handleCallbackQuery(tap("reminder_snooze:r1"));

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.userError);
    expect(h.answers).toEqual([{ id: "cb-1", options: { text: en.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("still strips the buttons, and logs, when answering the tap fails", async () => {
    h.answerError = new Error("query is too old");

    await expect(handleCallbackQuery(tap("reminder_done:r1"))).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.answerError);
    expect(h.markupEdits).toEqual([STRIPPED]);
  });

  it("logs and does not throw when Telegram refuses the button edit", async () => {
    h.markupError = new Error("message is not modified");

    await expect(handleCallbackQuery(tap("reminder_snooze:r1:3h"))).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[Bot]"), h.markupError);
    expect(h.answers).toHaveLength(1);
  });

  it("answers, logs why, and edits nothing when the tap carries no message", async () => {
    await handleCallbackQuery(tap("reminder_done:r1", false));

    expect(h.answers).toEqual([{ id: "cb-1", options: { text: he.bot.remindersRemoved } }]);
    expect(h.markupEdits).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reminder_done:r1"));
  });
});

describe("bot.remindersRemoved copy", () => {
  it("exists in every locale, written in that locale's own script", () => {
    expect(en.bot.remindersRemoved).toMatch(/reminders/i);
    expect(he.bot.remindersRemoved).toMatch(/[\u0590-\u05FF]/);
    expect(ru.bot.remindersRemoved).toMatch(/[\u0400-\u04FF]/);
  });
});
```

What would turn each test red after Step 6:
- **Removing the catch-all branch:** no answer and no markup edit. All tests in the first describe fail.
- **Passing through any of the original keyboard,** for example keeping the `web_app` Open List row from `query.message.reply_markup`: `STRIPPED` no longer matches (7 tests).
- **Reading `item_reminders` or `lists`,** or selecting more than `language` (for example `"id, language"`): the `h.reads` assertion fails (4 tests).
- **Any insert, update, upsert, delete or rpc:** it is recorded in `h.writes` and throws.
- **Hard-coding `"en"`:** the he and ru answers fail (6 tests).
- **Removing a try/catch:** the matching "does not throw" test rejects.
- **Removing a `console.error`, or the `console.warn` when there is no message:** the matching spy assertion fails.
- **Copying the English text into he or ru:** the script check fails.

Each of these was checked by mutating a copy.

- [ ] **Step 2: Run the test and see it fail.**
  - Command: `npx vitest run __tests__/unit/removed-reminder-buttons.test.ts`
  - Expected result: FAIL, 12 failed (12).
  - The four `it.each` cases and the en/ru/unknown-user/no-message cases fail with `AssertionError: expected [ { id: 'cb-1', …(1) } ] to deeply equal [ { id: 'cb-1', options: { …(1) } } ]`. The old branches answer `reminder.notFound`, never edit the markup, and read `item_reminders`.
  - The answer-fails case reports `promise rejected "Error: query is too old" instead of resolving`.
  - The lookup-error and markup-error cases fail on `expected "error" to be called with arguments`.
  - The copy test fails with `TypeError: .toMatch() expects to receive a string, but got undefined`.

- [ ] **Step 3: Add the locale key in all three files.** In each file, insert one line directly after the existing `bot.openList` line (HEAD line 208, inside `"bot": { ... }`).

`messages/en.json`, replace
```json
    "openList": "Open List",
```
with
```json
    "openList": "Open List",
    "remindersRemoved": "Reminders have been removed from the app.",
```

`messages/he.json`, replace
```json
    "openList": "פתח רשימה",
```
with
```json
    "openList": "פתח רשימה",
    "remindersRemoved": "התזכורות הוסרו מהאפליקציה.",
```

`messages/ru.json`, replace
```json
    "openList": "Открыть список",
```
with
```json
    "openList": "Открыть список",
    "remindersRemoved": "Напоминаний в приложении больше нет.",
```

- [ ] **Step 4: Remove the two now-unused imports in `src/services/bot.ts`.** Delete these two lines (HEAD 9-10) and leave the `createServerClient`, `serverEnv` and messages imports in place:
```ts
import { verifyListPermission } from "@/src/lib/api-auth";
import { completeRecurringItem, completeItemRespectingRecurrence } from "@/src/services/recurring";
```

- [ ] **Step 5: Delete `sendItemReminder` and `sendReminderDigest` in `src/services/bot.ts`** (HEAD 255-306).
  - Delete from the line `export async function sendItemReminder(` through the closing `}` of `sendReminderDigest`. That function ends with:
    ```ts
      } catch (error) {
        console.error("[Bot] Failed to send reminder digest:", error);
      }
    }
    ```
  - Also delete the blank line that follows, so that the closing `}` of `sendListReady` is followed by one blank line and then `// Handle approval/decline callbacks (called directly from webhook route)`.
  - `sendApprovalRequest`, `sendListReminder` and `sendListReady` stay unchanged.

- [ ] **Step 6: Replace the three `reminder_*` branches with one catch-all in `handleCallbackQuery`.**
  - Delete everything from the line `  } else if (data.startsWith("reminder_done:")) {` (HEAD 406) through the `  }` that closes the apply-snooze branch (HEAD 759). That `  }` follows:
    ```ts
        } catch (e) {
          console.error("[Bot] Failed to edit message:", e);
        }
    ```
    after `getMsg(lang, "reminder.snoozedItem")`.
  - Keep the final `}` that closes the function (HEAD 760), and keep the approve:/decline: branch above it unchanged.
  - Put this block in the deleted range, directly after the approve branch's closing `    }` of its `try/catch`. The tail of the file must then read exactly:

```ts
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  } else if (data.startsWith("reminder_")) {
    // Reminders were removed from the app (migration 028). Old reminder
    // messages still sit in chats, and their Done, Snooze and snooze-option
    // buttons land here. Without an answer Telegram keeps the button spinning.
    // Strip ALL buttons: Open List would open a list deleted with the feature.
    // Read-only on purpose: only the user's language is read, nothing is written.
    const { data: botUser, error: userError } = await supabase
      .from("users")
      .select("language")
      .eq("telegram_id", query.from.id)
      .maybeSingle();
    if (userError) {
      console.error("[Bot] Failed to read language for a removed reminder button:", userError);
    }
    const lang = botUser?.language || "en";

    try {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "bot.remindersRemoved") });
    } catch (e) {
      console.error("[Bot] Failed to answer a removed reminder button:", e);
    }

    if (!query.message) {
      console.warn(`[Bot] Removed reminder button "${data}" came without a message; no buttons to strip`);
      return;
    }

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to strip buttons from an old reminder message:", e);
    }
  }
}
```

- [ ] **Step 7: Run the new test and see it pass.**
  - Command: `npx vitest run __tests__/unit/removed-reminder-buttons.test.ts`
  - Expected result: PASS, 12 passed (12).

- [ ] **Step 8: Delete the delivery crons and their only helper.** These are the only consumers of the senders deleted in Step 5, and `reminder-suppression.ts` is imported only by the reminders cron. `git rm` also removes the then-empty `app/api/cron/` directories.
```bash
git rm app/api/cron/reminders/route.ts app/api/cron/digest/route.ts src/utils/reminder-suppression.ts
```

- [ ] **Step 9: Delete the reminder-only bot and delivery tests.** These five files hold 53 tests. They read the deleted branches or the deleted cron files, or import `decideReminderDelivery`.
```bash
git rm __tests__/unit/bot-reminder-done-failure.test.ts __tests__/unit/reminder-callback-auth.test.ts __tests__/unit/reminder-list-binding.test.ts __tests__/unit/snooze-keeps-recurrence.test.ts __tests__/unit/reminder-suppression.test.ts
```

- [ ] **Step 10: Regenerate Next's route types so the stale validator stops importing the deleted routes.**
  - Command: `npx next typegen`
  - Why: `.next/types/validator.ts` is generated, gitignored and covered by tsconfig's `include`. It contains `typeof import("../../app/api/cron/reminders/route.js")` and the same for digest, so without this `tsc` fails with TS2307.
  - This command is not a build. It does not run `migrate.mjs` and does not touch the network.
  - Expected result: it finishes with a "generated types" success line, and `grep -c "cron/" .next/types/validator.ts` prints `0`.

- [ ] **Step 11: Run the full gate.**
  - `npx vitest run`
    - Expected: all green.
    - Test files drop by 4 against the count after T1 (5 deleted, 1 added).
    - Tests drop by 41 (53 deleted, 12 added). Measured on HEAD 685eb83 without T1, that is 65→61 files and 550→509 tests.
    - `locale-parity.test.ts` stays green, because the key was added to all three locales.
  - `npx tsc --noEmit`
    - Expected: exit 0, no output.
    - `allMessages: Record<string, typeof enMessages>` still typechecks, because he and ru got the same key.
  - `npx eslint src/services/bot.ts __tests__/unit/removed-reminder-buttons.test.ts`
    - Expected: exit 0, no problems.
  - The JSON files are not linted by this config, and the deleted files can't be linted.

- [ ] **Step 12: Commit.**
```bash
git add src/services/bot.ts messages/en.json messages/he.json messages/ru.json __tests__/unit/removed-reminder-buttons.test.ts
git commit -F - <<'EOF'
feat(bot): answer old reminder buttons and remove reminder delivery

Old reminder messages stay in chats after reminders are removed. Any
reminder_* button now answers "Reminders have been removed from the app"
in the user's language and strips every button, Open List included, since
it would open a deleted list. The handler only reads users.language and
writes nothing.

Deletes sendItemReminder, sendReminderDigest, the three reminder_*
callback branches, the /api/cron/reminders and /api/cron/digest routes,
reminder-suppression.ts and their reminder-only tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
```

BOUNDARY NOTE: T2's boundary works. I applied the edits above to a scratch copy of HEAD 685eb83 (not the repo), and the gate came back green: tsc exit 0, eslint exit 0, 61 files and 509 tests passing.

There are two things the orchestrator should know:
1. **Stale route types after deleting routes.** Deleting route files leaves the generated `.next/types/validator.ts` pointing at them, so `tsc` goes red until `npx next typegen` runs (Step 10). T3 deletes more routes, so it needs the same step.
2. **The inventory's catch-all design is out of date.** It describes keeping the Open List row and reading `item_reminders.list_id`. That conflicts with this task and the spec, which say remove all buttons and read only the language. The test above fails if Open List is kept or if `item_reminders` is read.

A few stale comments mention the deleted files and are left for their owning tasks:
- `__tests__/unit/clear-completed.test.ts:96`, `app/api/lists/[id]/items/clear-completed/route.ts:55` and `app/api/lists/[id]/items/route.ts:504` name `app/api/cron/reminders/route.ts`. T3 handles these.
- `__tests__/unit/mutation-request-parity.test.ts:31` names `reminder-callback-auth.test.ts`. T6 handles this.

The `reminder.*` keys read by the deleted bot code stay in the locale files until T9.

---

### Task 3: T3 Server reminder API

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts`
- Modify: `app/api/lists/[id]/items/unmark-completed/route.ts`
- Modify: `app/api/lists/[id]/items/clear-completed/route.ts` (comments only)
- Delete (`git rm`): `app/api/lists/[id]/items/[itemId]/reminder/route.ts`
- Delete (`git rm`): `app/api/lists/[id]/items/[itemId]/reminder/[reminderId]/route.ts`
- Delete (`git rm`): `app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts`
- Delete (`git rm`): `app/api/lists/[id]/reminders/route.ts`
- Delete (`git rm`): `src/schemas/reminders.ts`
- Delete (`git rm`): `src/services/recurring.ts`
- Delete (`git rm`): `__tests__/unit/recurring-claim.test.ts`
- Delete (`git rm`): `__tests__/unit/complete-item-recurrence.test.ts`
- Delete (`git rm`): `__tests__/unit/unmark-completed-gate.test.ts`
- Delete (`git rm`): `__tests__/unit/delete-undo-reminders.test.ts`
- Modify: `__tests__/unit/clear-completed.test.ts` (drop the reminder assertion)
- Create: `__tests__/unit/items-completion-no-reminders.test.ts`
- Create: `__tests__/unit/unmark-completed-route.test.ts`
- Create: `__tests__/unit/reminders-api-removed.test.ts`

**Interfaces:**
- Consumes: T2 has already removed the only other importer of `src/services/recurring.ts` (`src/services/bot.ts`). The shared helper `__tests__/helpers/fake-supabase.ts` (`fakeSupabase`, `FakeCall`, `FakeResult`) already exists.
- Produces: nothing other tasks rely on.
  - After this task no route or module touches `item_reminders`, except the voice handler (T4) and the client (T5/T6).
  - `PATCH /items` with `{ itemId, completed: true }` is a plain update with no extra reads.
  - `POST /items/unmark-completed` no longer reads `lists`.
  - The client still calls the deleted URLs from `useItemHandlers.ts`, `executor-factory.ts` and `useListData.ts` as plain `fetch` strings. That is not a compile or test error, and T5/T6 remove those calls.

Files to leave alone:
- `app/api/lists/[id]/remind/route.ts` and `ready/route.ts` (the Remind/Ready nudge).
- `src/utils/recurring-respawn.ts` (grocery repeat).
- The grocery code in `items/route.ts`: `updates.recurring` and `updates.restoreRecurring`. `no-deleted-item-leak.test.ts` anchors on the strings `if (updates.restoreRecurring === true)` and `// Allow restoring soft-deleted items`, so neither may be touched.
- The `.eq("recurring", false)` line in `clear-completed/route.ts`.

- [ ] **Step 1: Write the failing PATCH/DELETE test.** Create `__tests__/unit/items-completion-no-reminders.test.ts` with exactly this content. It follows the `items-route-categorize.test.ts` fake-supabase pattern.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));

import { PATCH, DELETE } from "@/app/api/lists/[id]/items/route";

const params = { params: Promise.resolve({ id: "L" }) };
function patch(body: unknown) {
  return new NextRequest("https://app.test/api/lists/L/items", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}

beforeEach(() => {
  h.fake = null as unknown as typeof h.fake;
});

// Reminders are gone: ticking an item off is one plain UPDATE on items, in every list type.
// It used to read item_reminders (and lists, and items) first, to advance a repeating series.
describe("PATCH /api/lists/[id]/items completion", () => {
  it("a bare completion is a single update on items", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: { id: "a", completed: true }, error: null }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: "a", completed: true }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "a", completed: true });
    expect(h.fake.calls).toHaveLength(1);
    const [update] = h.fake.calls;
    expect(update).toMatchObject({ table: "items", op: "update" });
    expect(update.values).toMatchObject({ completed: true });
    expect((update.values as { completed_at: unknown }).completed_at).toEqual(expect.any(String));
    expect(update.filters).toEqual(expect.arrayContaining(["eq:id=a", "eq:list_id=L", "is:deleted_at=null"]));
  });

  it("never reads item_reminders or lists, even if the item still has a live recurring reminder row", async () => {
    use((c) => {
      if (c.table === "item_reminders") {
        return { data: { created_by: "u1", remind_at: "2026-10-01T09:00:00Z", recurrence: "daily", is_shared: false }, error: null };
      }
      if (c.table === "lists") return { data: { type: "reminders" }, error: null };
      if (c.table === "items" && c.op === "select") return { data: { text: "call mom" }, error: null };
      if (c.table === "items" && c.op === "update") return { data: { id: "a", completed: true }, error: null };
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: "a", completed: true }), params);

    expect(res.status).toBe(200);
    expect(h.fake.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
  });
});

// Guard rather than red-first: DELETE already had no reminder code (only a long comment).
// It fails if someone adds a reminder cancel, or any second query, back into the handler.
describe("DELETE /api/lists/[id]/items", () => {
  it("soft-deletes the item with one update on items and nothing else", async () => {
    use(() => ({ data: null, error: null }));

    const res = await DELETE(
      new NextRequest("https://app.test/api/lists/L/items?itemId=a", { method: "DELETE" }),
      params
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.fake.calls).toHaveLength(1);
    const [update] = h.fake.calls;
    expect(update).toMatchObject({ table: "items", op: "update" });
    expect((update.values as { deleted_at: unknown }).deleted_at).toEqual(expect.any(String));
    expect(update.filters).toEqual(expect.arrayContaining(["eq:id=a", "eq:list_id=L"]));
  });
});
```

- [ ] **Step 2: Write the failing unmark-completed test.** Create `__tests__/unit/unmark-completed-route.test.ts`. It replaces `unmark-completed-gate.test.ts`, which asserted the reminders guard.

```ts
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { POST } from "@/app/api/lists/[id]/items/unmark-completed/route";

const params = { params: Promise.resolve({ id: "L" }) };
const req = () => new NextRequest("https://app.test/api/lists/L/items/unmark-completed", { method: "POST" });
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}

describe("POST /api/lists/[id]/items/unmark-completed", () => {
  it("flips completed items back with a single update and does not read the lists table", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: [{ id: "a" }, { id: "b" }], error: null }
      : { data: { type: "regular" }, error: null });

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 2, unmarkedIds: ["a", "b"] });
    expect(h.fake.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
    const [update] = h.fake.calls;
    expect(update.values).toEqual({ completed: false, completed_at: null });
    expect([...update.filters].sort()).toEqual(
      ["eq:completed=true", "eq:list_id=L", "is:deleted_at=null", "select:id"].sort()
    );
  });

  it("no longer special-cases a list whose stored type is still 'reminders' (no 400)", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: [{ id: "a" }], error: null }
      : { data: { type: "reminders" }, error: null });

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 1, unmarkedIds: ["a"] });
  });
});
```

- [ ] **Step 3: Write the failing removal test.** Create `__tests__/unit/reminders-api-removed.test.ts`. It also guards the Remind/Ready nudge against over-deletion.

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";

const exists = (p: string) => existsSync(resolve(process.cwd(), p));

// The reminder API is gone for good. A file coming back means the feature was half-restored.
describe("reminder API surface is removed", () => {
  it.each([
    "app/api/lists/[id]/items/[itemId]",
    "app/api/lists/[id]/items/[itemId]/reminder/route.ts",
    "app/api/lists/[id]/items/[itemId]/reminder/[reminderId]/route.ts",
    "app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts",
    "app/api/lists/[id]/reminders",
    "app/api/lists/[id]/reminders/route.ts",
    "src/schemas/reminders.ts",
    "src/services/recurring.ts",
  ])("%s does not exist", (path) => {
    expect(exists(path)).toBe(false);
  });
});

// Names overlap with the reminders code, but this is the shared-list nudge and stays.
describe("the Remind/Ready nudge and grocery repeat are untouched", () => {
  it.each([
    "app/api/lists/[id]/remind/route.ts",
    "app/api/lists/[id]/ready/route.ts",
    "src/utils/recurring-respawn.ts",
  ])("%s still exists", (path) => {
    expect(exists(path)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the three new files and confirm they fail for the right reason.**
  Command: `npx vitest run __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/reminders-api-removed.test.ts`
  Expected failures, with the other tests passing:
  - `items-completion-no-reminders`: both PATCH tests fail. The calls list is `["item_reminders:select", ...]` instead of `["items:update"]`, and `toHaveLength(1)` fails. The DELETE test passes (it is a guard).
  - `unmark-completed-route`: both tests fail. The first sees a `lists:select` call. The second gets a 400 instead of 200.
  - `reminders-api-removed`: 8 "does not exist" tests fail with `expected true to be false`. The 3 "still exists" tests pass.

- [ ] **Step 5: Remove the recurring import from `app/api/lists/[id]/items/route.ts`.** Delete this whole line (HEAD line 10) and leave the neighbouring imports as they are:

```ts
import { completeItemRespectingRecurrence, isPureCompletion } from "@/src/services/recurring";
```

  The import block must then read, in order: `...pickRecyclable...`, then `import { categorizeList } from "@/src/services/categorize-list";`.

- [ ] **Step 6: Remove the completion hand-off in PATCH.** In the same file, delete the block that starts with `  // A pure "mark completed" on an item with a live recurring reminder must advance` (HEAD line 334) and ends with the `  }` that closes `if (isPureCompletion(updates)) {` (HEAD line 353). The block's last lines are:

```ts
      return NextResponse.json(done ?? { id: itemId, completed: true });
    }
  }
```

  Also delete the one blank line after the block. What must remain is the category check's closing `  }` followed by one blank line and then `  const patchData: Record<string, unknown> = {};`. Do not touch anything else in PATCH.

- [ ] **Step 7: Remove the stale PATCH comment.** Delete these two lines (HEAD 450-451) and the blank line after them:

```ts
  // Don't cancel reminders on completion — the cron handles cleanup for completed items,
  // and the frontend needs the reminder to display the original time in the done section.
```

  What must remain is the closing `  }` of the `scheduleCategorize` block, one blank line, then `  return NextResponse.json(item);`.

- [ ] **Step 8: Remove the DELETE comment block.** Delete the comment that starts `  // Deliberately does NOT cancel reminders on the deleted item. Both undo` (HEAD 495) and ends `  // ever fires for a row that stays deleted.` (HEAD 506). The last handler lines must read:

```ts
  if (error) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 9: Remove the reminders guard from `unmark-completed/route.ts`.** Replace HEAD lines 24-43, from `  // Reminders lists hold recurring occurrences:` through `  // Flip all completed items back to active (non-destructive; reminders survive)`. That range includes the `lists` select, the `if (listError)` return and the `if (list?.type === "reminders")` 400 guard. Replace it with this single comment line:

```ts
  // Flip all completed items back to active (non-destructive)
```

  The handler must then read: `const supabase = createServerClient();`, a blank line, that comment, then `const { data: unmarked, error } = await supabase.from("items").update(...)` as before. Everything else (auth, permission check, the 500 on error, the response shape) stays.

- [ ] **Step 10: Remove the comment block in `clear-completed/route.ts`.** Delete the comment that starts `  // Deliberately does NOT cancel reminders on cleared items here. Completing an` (HEAD 46) and ends `  // fires for a row that stays cleared.` (HEAD 57). What must remain is the closing `  }` of the `if (error)` block, one blank line, then `  return NextResponse.json({ cleared: ...`. No code changes. The `.eq("recurring", false)` line and the 24-29 comment stay.

- [ ] **Step 11: Delete the reminder routes and modules.** The route importers are gone after Steps 5-6. `bot.ts` was cleaned in T2.
  Command:

```bash
git rm "app/api/lists/[id]/items/[itemId]/reminder/route.ts" \
       "app/api/lists/[id]/items/[itemId]/reminder/[reminderId]/route.ts" \
       "app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts" \
       "app/api/lists/[id]/reminders/route.ts" \
       src/schemas/reminders.ts src/services/recurring.ts
```

  Then confirm the empty directories are gone: `ls "app/api/lists/[id]/items"` must list only `clear-completed`, `reorder`, `route.ts`, `search`, `unmark-completed`, `unskip-all`. Also `ls "app/api/lists/[id]"` must list `categories`, `items`, `ready`, `remind`. If git left an empty `[itemId]` or `reminders` directory behind, remove it with `rmdir`.

  Then regenerate Next's route types, because the generated `.next/types/validator.ts` and `routes.d.ts` still import the deleted routes and `tsc` would report TS2307: run `npx next typegen`, then `grep -cE "complete-recurring|/reminder|lists/\[id\]/reminders" .next/types/validator.ts` must print `0`.

- [ ] **Step 12: Delete the four reminder-only test files.** Those tests cover 15 + 18 + 2 + 2 = 37 cases.
  Command: `git rm __tests__/unit/recurring-claim.test.ts __tests__/unit/complete-item-recurrence.test.ts __tests__/unit/unmark-completed-gate.test.ts __tests__/unit/delete-undo-reminders.test.ts`

- [ ] **Step 13: Trim `__tests__/unit/clear-completed.test.ts`.** Delete the comment block and the test below. Start at `  // Completing an item deliberately never cancels its reminder (a completed item` (HEAD 90) and end at the closing `  });` of `it("does not cancel reminders when clearing completed items ...` (HEAD 104). Also delete the blank line before the comment (HEAD 89). The describe must end like this:

```ts
  it("excludes recurring rows from the clear query", () => {
    expect(source).toContain('.eq("recurring", false)');
  });
});
```

  The file goes from 6 tests to 5. The `.eq("recurring", false)` test stays and protects the grocery repeat items.

- [ ] **Step 14: Run the new files and the neighbouring route tests. They must be green.**
  Command: `npx vitest run __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/reminders-api-removed.test.ts __tests__/unit/clear-completed.test.ts __tests__/unit/no-deleted-item-leak.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/items-get-columns.test.ts __tests__/unit/unmark-completed.test.ts`
  Expected: all pass. The new files give 3 + 2 + 11 = 16 tests. `clear-completed` has 5. `no-deleted-item-leak` is unchanged and proves its two anchor strings survived.

- [ ] **Step 15: Prove the tests bite (do not commit this).**
  - First, temporarily re-insert the line `await supabase.from("item_reminders").select("id").limit(1);` right after `const supabase = createServerClient();` in PATCH. Run `npx vitest run __tests__/unit/items-completion-no-reminders.test.ts`. Both PATCH tests must go red.
  - Second, restore the file with `git checkout -- "app/api/lists/[id]/items/route.ts"` only if it had no other uncommitted edits. Otherwise remove the line by hand.
  - Third, temporarily re-add `if (list?.type === "reminders")` plus the `lists` read to `unmark-completed/route.ts`. `unmark-completed-route.test.ts` must go red. Then revert that.
  - Run the three files again to confirm green.

- [ ] **Step 16: Run the full gate.**
  - `npx vitest run`. Expected: all green. Relative to the state after T2, the total drops by 23 tests: -37 (four deleted files), -1 (`clear-completed`), +16 (three new files, 3 + 2 + 11). Tests that read `app/api/lists/[id]/items/route.ts` (`items-route-categorize`, `no-deleted-item-leak`, `items-get-columns`, `recycle-scoping`, `voice-categorize-wiring`) are unchanged.
  - `npx tsc --noEmit`. Expected: no errors. No remaining file imports `@/src/services/recurring` or `@/src/schemas/reminders`. `grep -rnE "services/recurring['\"]|schemas/reminders['\"]" app src components __tests__` must print nothing.
  - `npx eslint "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" "app/api/lists/[id]/items/clear-completed/route.ts" __tests__/unit/clear-completed.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/reminders-api-removed.test.ts`. Expected: no errors or warnings.

- [ ] **Step 17: Commit.**

```bash
git add "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" "app/api/lists/[id]/items/clear-completed/route.ts" __tests__/unit/clear-completed.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/reminders-api-removed.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove the reminder API and the recurring-series hand-off

Delete the item reminder, complete-recurring and list reminders routes,
src/services/recurring.ts and src/schemas/reminders.ts. A PATCH completion
is now one plain update (it no longer reads item_reminders, lists and items
first), unmark-completed drops its reminders-list guard and list read, and
the stale reminder comments in clear-completed and DELETE /items go.
Reminder-only tests are replaced by behavioural tests of the new route
shapes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

BOUNDARY NOTE: tsc, vitest and eslint stay green at the end of T3, with no work moved between tasks. After this commit the client still calls the deleted URLs as plain `fetch` strings: `/reminder`, `/reminder/<id>` and `/complete-recurring` in `useItemHandlers.ts`, `/complete-recurring` in `executor-factory.ts`, and `/reminders` in `useListData.ts`. Neither the compiler nor the tests see these. `executor-factory.test.ts` only asserts the URL against a mocked fetch. At runtime on this local branch those calls would 404 until T5/T6 remove them, so the branch must not be deployed between T3 and T6. The voice handler also still inserts into `item_reminders` until T4. Both are covered by the plan's single-release, local-branch rule.

---

### Task 4: Voice stops setting reminders and stops reading the time zone

**Files:**
- Modify: `src/services/voice-processor.ts`
- Modify: `src/services/voice-handler.ts`
- Modify: `__tests__/unit/voice-processor.test.ts`
- Modify: `__tests__/unit/voice-processor-sdk.test.ts`
- Create: `__tests__/unit/voice-handler-no-reminders.test.ts`

**Interfaces:**
- Consumes: none (T1-T3 do not touch voice files).
- Produces: `VoiceItem = { text: string; action: "add" | "remove"; targetList: string | null }` (no `remind_at`, no `recurrence`). `VoiceProcessor.process(audio: Buffer, listNames: string[]): Promise<VoiceResult>` (the `timezone` and `currentTime` parameters are gone). `voice-handler.ts` no longer selects `users.timezone`. T8 and T11 rely on this: after T4, nothing on the server reads `users.timezone`.

- [ ] **Step 1: Update `__tests__/unit/voice-processor.test.ts` to the new contract and add the new tests**

  a. Delete the two constants. Anchor (HEAD lines 30-31):
  ```ts
  const TZ = "Asia/Jerusalem";
  const NOW = "2026-10-07T18:00:00.000Z";
  ```
  `AUDIO`, `LISTS` and `okResponse` stay.

  b. Replace the `run()` helper (HEAD 41-43) with this block, which also adds the prompt helper:
  ```ts
  async function run() {
    return new GeminiVoiceProcessor().process(AUDIO, LISTS);
  }

  function sentPrompt(): string {
    const { contents } = h.generateContent.mock.calls[0][0];
    return contents.find((p: { text?: string }) => typeof p.text === "string").text;
  }
  ```

  c. In the test `sends the schema as responseJsonSchema, ...`, delete this line (HEAD 91):
  ```ts
      expect(item.properties.remind_at.type).toEqual(["string", "null"]);
  ```

  d. In the test `sends the prompt as text plus the voice note as inline base64 audio/ogg`, delete these two lines (HEAD 102-103):
  ```ts
      expect(textPart.text).toContain(TZ);
      expect(textPart.text).toContain(NOW);
  ```

  e. Add these three tests at the end of `describe("GeminiVoiceProcessor request", ...)`, after the prompt test:
  ```ts
    it("offers the model only text, action and targetList, with no reminder fields", async () => {
      h.generateContent.mockResolvedValue(okResponse({ items: [] }));
      await run();

      const item = h.generateContent.mock.calls[0][0].config.responseJsonSchema.properties.items.items;
      expect(Object.keys(item.properties).sort()).toEqual(["action", "targetList", "text"]);
      expect(item.properties).not.toHaveProperty("remind_at");
      expect(item.properties).not.toHaveProperty("recurrence");
    });

    it("tells the model to drop command words and keep time words in the item text", async () => {
      h.generateContent.mockResolvedValue(okResponse({ items: [] }));
      await run();

      const prompt = sentPrompt();
      for (const command of ['"remind me to"', '"add"', '"put on the list"']) {
        expect(prompt).toContain(command);
      }
      expect(prompt).toMatch(/keep any time or date words/i);
      expect(prompt).toContain('"remind me to call mom at 9" -> "call mom at 9"');
      // The old rule stripped them ("no time words") so that remind_at could carry the time.
      expect(prompt).not.toMatch(/no time words/i);
      expect(prompt).not.toMatch(/remind_at|recurrence/);
    });

    it("sends no current time or time zone, since nothing reads them any more", async () => {
      h.generateContent.mockResolvedValue(okResponse({ items: [] }));
      await run();

      const prompt = sentPrompt();
      expect(prompt).not.toMatch(/Now:|TZ:/);
      expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });
  ```

  f. Replace the whole test `returns valid items, including a timed recurring reminder` (HEAD 109-127) with:
  ```ts
    it("returns valid items with only text, action and targetList", async () => {
      h.generateContent.mockResolvedValue(
        okResponse({
          items: [
            { text: "חלב", action: "add", targetList: "קניות" },
            { text: "вынести мусор в четверг", action: "add", targetList: "Дом" },
            { text: "eggs", action: "remove", targetList: null },
          ],
        })
      );

      const result = await run();
      expect(h.generateContent).toHaveBeenCalledOnce();
      expect(result.items).toStrictEqual([
        { text: "חלב", action: "add", targetList: "קניות" },
        { text: "вынести мусор в четверг", action: "add", targetList: "Дом" },
        { text: "eggs", action: "remove", targetList: null },
      ]);
    });

    it("ignores a stray remind_at or recurrence and keeps the item text with its time words", async () => {
      h.generateContent.mockResolvedValue(
        okResponse({
          items: [
            { text: "call mom at 9", action: "add", targetList: "Дом", remind_at: "2026-10-08T09:00:00+03:00", recurrence: "daily" },
            { text: "pay rent tomorrow", action: "add", targetList: "Дом", remind_at: "tomorrow 9am", recurrence: "weekly" },
          ],
        })
      );

      const result = await run();
      expect(h.generateContent).toHaveBeenCalledOnce();
      expect(result.items).toStrictEqual([
        { text: "call mom at 9", action: "add", targetList: "Дом" },
        { text: "pay rent tomorrow", action: "add", targetList: "Дом" },
      ]);
      // Nothing parses the field any more, so nothing warns about it either.
      expect(console.warn).not.toHaveBeenCalled();
    });
  ```

  g. Delete the whole test `keeps a remind_at in any offset spelling Postgres accepts, as one canonical UTC instant`. It runs from `it("keeps a remind_at in any offset spelling Postgres accepts` to its closing `});` (HEAD 148-172). Also delete the whole test `nulls and logs a remind_at without an offset or that is not a real time, and drops an unknown recurrence`, which runs from `it("nulls and logs a remind_at without an offset` to its closing `});` (HEAD 174-206). These tests stay unchanged: `drops items whose action is not exactly add/remove ...`, `normalizes a missing, blank or non-string targetList to null`, `logs the block reason ...`, the `it.each` block and `returns no items and logs the HTTP status ...`.

  What makes each new test go red: a schema that still lists `remind_at` or `recurrence` fails the first one. Keeping the old "no time words" rule, or the `remind_at` bullet, fails the second. Keeping `Now: ${currentTime}, TZ: ${timezone}` in the prompt fails the third, because it renders `Now: undefined, TZ: undefined`. A parser that still copies `remind_at`/`recurrence` into the item (even as `null`) fails `returns valid items ...`, because `toStrictEqual` is used. A parser that still copies them, or still warns, fails `ignores a stray remind_at ...`.

- [ ] **Step 2: Update `__tests__/unit/voice-processor-sdk.test.ts`**

  Replace the `run()` helper (HEAD 54-56) with:
  ```ts
  async function run() {
    return new GeminiVoiceProcessor().process(AUDIO, ["Groceries"]);
  }
  ```
  In the test `sends the model, JSON schema, LOW thinking and inline audio in the REST body`, replace the expectation (HEAD 78-80):
  ```ts
      expect(result.items).toEqual([
        { text: "milk", action: "add", targetList: "Groceries", remind_at: null, recurrence: null },
      ]);
  ```
  with:
  ```ts
      expect(result.items).toStrictEqual([{ text: "milk", action: "add", targetList: "Groceries" }]);
  ```

- [ ] **Step 3: Create `__tests__/unit/voice-handler-no-reminders.test.ts`**
  ```ts
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "fs";
  import { resolve } from "path";

  // Source inspection, like voice-categorize-wiring: handleVoiceMessage needs Telegram, Gemini
  // and Supabase, so it can't run in node. Reminders are gone (spec 2026-10-28): a voice note
  // only adds or removes items and never reads the user's time zone.
  const src = readFileSync(resolve(process.cwd(), "src/services/voice-handler.ts"), "utf8");

  describe("voice handler without reminders", () => {
    it("never writes or cancels a reminder row", () => {
      expect(src).not.toContain("item_reminders");
      expect(src).not.toMatch(/remind_at|recurrence/);
    });

    it("reads only the user's id and language", () => {
      expect(src).toContain('.select("id, language")');
      expect(src).not.toMatch(/timezone/i);
    });

    it("passes only the audio and the list names to the processor", () => {
      expect(src).toMatch(/processor\.process\(audioBuffer, listNames\)/);
    });
  });
  ```
  What makes each test go red: putting back the reminder update or insert block fails the first test. Putting `timezone` back in the users select, or `user.timezone` anywhere, fails the second. Passing a time zone or the current time to `process` again fails the third.

- [ ] **Step 4: Run the tests and watch them fail**

  Run `npx vitest run __tests__/unit/voice-processor.test.ts __tests__/unit/voice-processor-sdk.test.ts __tests__/unit/voice-handler-no-reminders.test.ts`

  Expected: 9 failures.
  - voice-processor.test.ts has 5: `offers the model only text, action and targetList ...` (keys include `recurrence` and `remind_at`), `tells the model to drop command words ...` (no `"remind me to"`), `sends no current time or time zone ...` (prompt contains `Now: undefined, TZ: undefined`), `returns valid items with only text, action and targetList` (extra `remind_at: null, recurrence: null`) and `ignores a stray remind_at ...` (`remind_at: "2026-10-08T06:00:00.000Z"` is present, and console.warn was called with `"[VoiceProcessor] dropped unusable remind_at"`).
  - voice-processor-sdk.test.ts has 1: the REST-body test (extra `remind_at`/`recurrence`).
  - voice-handler-no-reminders.test.ts has 3: all of them.
  - Everything else passes.

- [ ] **Step 5: Rewrite the schema and types in `src/services/voice-processor.ts`**

  Replace the `voiceResultSchema` item `properties` block (HEAD 37-43):
  ```ts
          properties: {
            text: { type: "string" },
            action: { type: "string", enum: ["add", "remove"] },
            targetList: { type: ["string", "null"] },
            remind_at: { type: ["string", "null"] },
            recurrence: { type: ["string", "null"] },
          },
  ```
  with:
  ```ts
          properties: {
            text: { type: "string" },
            action: { type: "string", enum: ["add", "remove"] },
            targetList: { type: ["string", "null"] },
          },
  ```
  Replace the `VoiceItem`, `VoiceResult` and `VoiceProcessor` declarations (HEAD 51-65) with:
  ```ts
  export interface VoiceItem {
    text: string;
    action: "add" | "remove";
    targetList: string | null;
  }

  export interface VoiceResult {
    items: VoiceItem[];
  }

  export interface VoiceProcessor {
    process(audio: Buffer, listNames: string[]): Promise<VoiceResult>;
  }
  ```

- [ ] **Step 6: Delete the reminder-time parsing from `src/services/voice-processor.ts`**

  Delete the whole block from `// Same set the reminder API accepts (src/schemas/reminders.ts).` to the closing `}` of `function parseRemindAt` (HEAD 67-82). That covers `RECURRENCES`, the `REMIND_AT` regex with its two comment lines, and `parseRemindAt`.

  Then replace the doc comment and the loop body of `parseVoiceResult` (HEAD 84-119). The old text runs from `/**` and ` * Parse the model's JSON and drop anything the handler must not act on.` down to the `items.push({ ... recurrence, });`. The new text:
  ```ts
  /**
   * Parse the model's JSON and drop anything the handler must not act on. Structured output
   * guarantees the shape, not the values: an action other than "add" would otherwise reach
   * the handler's remove branch. Only text, action and targetList are copied, so a stray
   * field from an older schema never reaches the handler. Throws when the text is not
   * JSON or has no items array.
   */
  function parseVoiceResult(text: string): VoiceResult {
    const rawItems = (JSON.parse(text) as { items?: unknown } | null)?.items;
    if (!Array.isArray(rawItems)) {
      throw new Error("Gemini response has no items array");
    }

    const items: VoiceItem[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.text !== "string" || !r.text.trim()) continue;
      if (r.action !== "add" && r.action !== "remove") continue;

      items.push({
        text: r.text.trim(),
        action: r.action,
        targetList: typeof r.targetList === "string" && r.targetList.trim() ? r.targetList : null,
      });
    }
  ```
  The rest of the function stays as it is: the `if (items.length < rawItems.length) { console.warn(...dropped ... invalid item(s)) }` and the `return { items };`.

- [ ] **Step 7: Rewrite the `process` signature and the prompt in `src/services/voice-processor.ts`**

  Replace HEAD 135-144. The old text runs from `  async process(audio: Buffer, listNames: string[], timezone: string, currentTime: string): Promise<VoiceResult> {` through the prompt's closing line `- ONLY if user says a time/schedule: ... Otherwise leave them null.\`;`. The new text:
  ```ts
    async process(audio: Buffer, listNames: string[]): Promise<VoiceResult> {
      const listNamesStr = listNames.join(", ");

      const prompt = `Shopping/task list assistant. Lists: [${listNamesStr}].

  Extract items to add/remove. Rules:
  - Match list names from available lists, or infer from context. One list = assign all to it.
  - Mixed languages OK (Hebrew, English, Russian).
  - Each item = separate entry. Item text = the item itself: drop command words in any language (e.g. "remind me to", "add", "put on the list"). Keep any time or date words: "remind me to call mom at 9" -> "call mom at 9".`;
  ```
  Nothing else changes: `config` (responseJsonSchema, ThinkingLevel.LOW, httpOptions timeout/retry), the try/catch with its `console.error` logs, the finish-reason check and `getVoiceProcessor` all stay as they are.

- [ ] **Step 8: Remove the reminder path from `src/services/voice-handler.ts`**

  a. In the user lookup (HEAD 80), replace `      .select("id, language, timezone")` with `      .select("id, language")`.

  b. In the Gemini call (HEAD 213), replace
  ```ts
        result = await processor.process(audioBuffer, listNames, user.timezone || "UTC", new Date().toISOString());
  ```
  with
  ```ts
        result = await processor.process(audioBuffer, listNames);
  ```

  c. Replace the add branch (HEAD 280-318). The old text runs from `      if (voiceItem.action === "add") {` and `        const itemId = await processAddItem(` down to the end of the reminder block (`receipt.added[receipt.added.length - 1] += \` \u23F0 ${timeStr}${recLabel}\`;` followed by `        }`), just before `      } else {`. The new text:
  ```ts
        if (voiceItem.action === "add") {
          await processAddItem(
            supabase,
            bot,
            chatId,
            targetList.id,
            voiceItem,
            user.id,
            receipt,
            lang
          );
        } else {
  ```
  The `else` branch with `processRemoveItem(...)` stays as it is, and so do `receipts.set(...)`, the receipt sending, `listsToSort` and `categorizeList`. `processAddItem` keeps its `Promise<string | null>` return and both `recycleItem` calls (recycle-scoping.test.ts counts those calls). Only the unused `itemId` binding is gone.

- [ ] **Step 9: Run the tests and watch them pass**

  Run `npx vitest run __tests__/unit/voice-processor.test.ts __tests__/unit/voice-processor-sdk.test.ts __tests__/unit/voice-handler-no-reminders.test.ts __tests__/unit/voice-categorize-wiring.test.ts __tests__/unit/recycle-scoping.test.ts`

  Expected: everything passes. voice-processor.test.ts has 18 tests (was 16: minus 2, plus 4), voice-processor-sdk.test.ts has 3, and voice-handler-no-reminders.test.ts has 3. voice-categorize-wiring and recycle-scoping are unchanged and green.

- [ ] **Step 10: Run the gate**

  - `npx vitest run`: all green, 5 more tests than after T3 (one new file).
  - `npx tsc --noEmit`: no errors. The only caller of `process` is voice-handler.ts, and the tests now call it with 2 arguments.
  - `npx eslint src/services/voice-processor.ts src/services/voice-handler.ts __tests__/unit/voice-processor.test.ts __tests__/unit/voice-processor-sdk.test.ts __tests__/unit/voice-handler-no-reminders.test.ts`: no output, exit 0 (these files are lint-clean at HEAD).

- [ ] **Step 11: Commit**
  ```bash
  git add src/services/voice-processor.ts src/services/voice-handler.ts __tests__/unit/voice-processor.test.ts __tests__/unit/voice-processor-sdk.test.ts __tests__/unit/voice-handler-no-reminders.test.ts
  git commit -F - <<'EOF'
  feat(voice): stop setting reminders from voice notes

  Voice no longer asks Gemini for remind_at or recurrence, no longer inserts
  item_reminders rows, and no longer sends the current time or the user's
  time zone. The prompt now drops command words ("remind me to", "add") and
  keeps time and date words, so "remind me to call mom at 9" adds the item
  "call mom at 9". The handler stops reading users.timezone.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  EOF
  ```

---

### Task 5: Remove the client reminders UI (T5)

**Files:**
- Delete: `components/ReminderSheet.tsx`
- Delete: `components/TimePicker.tsx`
- Modify: `package.json` and `package-lock.json` (via `npm uninstall @ncdai/react-wheel-picker`)
- Modify: `app/list/[id]/page.tsx`
- Modify: `app/page.tsx`
- Modify: `components/ItemRow.tsx`
- Modify: `components/SortableItem.tsx`
- Modify: `components/list/CompletedItemsSection.tsx`
- Modify: `components/AddItemInput.tsx`
- Modify: `src/utils/search-completed-items.ts`
- Modify: `app/globals.css`
- Modify: `__tests__/unit/list-type-switch.test.ts`
- Modify: `__tests__/unit/grouped-list-wiring.test.ts`
- Modify: `__tests__/unit/search-completed-items.test.ts`
- Create: `__tests__/unit/reminders-ui-removed.test.ts`

**Interfaces:**
- Consumes: nothing new. T1-T4 are server and bot only, so none of them touches these files.
- Produces:
  - `computeSuggestions(items: ItemData[], value: string): Suggestion[]` (the `listType` first parameter is gone).
  - `shouldSearchWhileTyping` no longer exists.
  - `AddItemInput` props are `{ items: ItemData[]; onAddItem: (text: string, recycleId?: string) => void }` (no `listType`).
  - `ItemRow` and `SortableItem` no longer accept `reminderAt`, `onReminderTap`, `recurrence` or `isOverdue`.
  - The list page no longer destructures `handleSetReminder`, `handleUpdateReminder` or `handleCancelReminder` from `useItemHandlers`. The hook still returns them until T6.
  - The list page still passes `listType` to `useItemHandlers`, and `ListType` still includes `"reminders"` (T6 and T7).

- [ ] **Step 1: Write the new source-inspection test (red first)**

Create `__tests__/unit/reminders-ui-removed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Reminders were removed from the client. These pin what is gone, and that the neighbours
// that share words with it (the grocery Repeat toggle, the Remind/Ready nudge toast, the
// pending Clock) are still there.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("reminder components are deleted", () => {
  it("ReminderSheet and TimePicker no longer exist", () => {
    expect(existsSync(resolve(process.cwd(), "components/ReminderSheet.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "components/TimePicker.tsx"))).toBe(false);
  });

  it("the wheel-picker package is neither a dependency nor in the lockfile", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).not.toContain("@ncdai/react-wheel-picker");
    const lock = JSON.parse(read("package-lock.json"));
    expect(Object.keys(lock.packages[""].dependencies)).not.toContain("@ncdai/react-wheel-picker");
    expect(lock.packages["node_modules/@ncdai/react-wheel-picker"]).toBeUndefined();
  });

  it("globals.css has no bell or wheel-picker rules, and its utilities layer still closes", () => {
    const css = read("app/globals.css");
    expect(css).not.toMatch(/bell-pulse|bell-ring|time-picker|data-rwp/);
    expect(css).not.toMatch(/set reminder/);
    // The rules before the deleted block are still there.
    expect(css).toContain("@keyframes dropdown-pop");
  });
});

describe("item rows carry no reminder UI", () => {
  const stripped = /reminderAt|onReminderTap|isOverdue|recurrence|formatShortTime|bell-pulse|\bBell\b/;

  it("ItemRow has no bell, time label or overdue state, but keeps Clock and Repeat", () => {
    const src = read("components/ItemRow.tsx");
    expect(src).not.toMatch(stripped);
    expect(src).toContain("<Clock");
    expect(src).toContain("<Repeat");
  });

  it("SortableItem no longer passes reminder props through", () => {
    expect(read("components/SortableItem.tsx")).not.toMatch(stripped);
  });

  it("CompletedItemsSection no longer passes reminder props to ItemRow", () => {
    const src = read("components/list/CompletedItemsSection.tsx");
    expect(src).not.toMatch(stripped);
    expect(src).not.toMatch(/my_remind|my_reminder/);
  });
});

describe("the list page and pickers have no Reminders type", () => {
  it("the list page has no reminders branch, sheet, state or handlers", () => {
    const src = read("app/list/[id]/page.tsx");
    expect(src).not.toMatch(
      /isReminders|ReminderSheet|ReminderItemsList|groupByDate|reminderItem|pendingReminderText|handleSetReminder|handleUpdateReminder|handleCancelReminder|my_remind|"reminders"|typeReminders/
    );
    // The nudge toast shares the word and must survive.
    expect(src).toContain("reminderToast={reminderToast}");
  });

  it("the add box is not told the list type", () => {
    const src = read("app/list/[id]/page.tsx");
    const start = src.indexOf("<AddItemInput");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf("/>", start))).not.toContain("listType");
  });

  it("the new-list picker offers no Reminders choice", () => {
    expect(read("app/page.tsx")).not.toMatch(/"reminders"|typeReminders/);
  });
});

describe("the add box", () => {
  it("always shows the normal placeholder and takes no list type", () => {
    const src = read("components/AddItemInput.tsx");
    expect(src).not.toMatch(/listType|reminders|addReminderPlaceholder/);
    expect(src).toContain("placeholder={t('items.addPlaceholder')}");
  });
});
```

- [ ] **Step 2: Run it and expect red**

Run `npx vitest run __tests__/unit/reminders-ui-removed.test.ts`. Expected: all 10 tests fail, because nothing is removed yet.

- [ ] **Step 3: Update `__tests__/unit/search-completed-items.test.ts` (red first)**

Make four edits.

a) Replace the import line:
```ts
import { searchCompletedItems, shouldSearchWhileTyping, computeSuggestions } from "@/src/utils/search-completed-items";
```
with:
```ts
import { searchCompletedItems, computeSuggestions } from "@/src/utils/search-completed-items";
```

b) Delete the whole block below. It starts at `describe("shouldSearchWhileTyping", () => {` and ends at its closing `});`, followed by one blank line. HEAD lines are about 92-98.
```ts
describe("shouldSearchWhileTyping", () => {
  it("is off for reminders only", () => {
    expect(shouldSearchWhileTyping("reminders")).toBe(false);
    expect(shouldSearchWhileTyping("regular")).toBe(true);
    expect(shouldSearchWhileTyping("grocery")).toBe(true);
  });
});

```

c) Replace the whole `describe("computeSuggestions", ...)` body with:
```ts
describe("computeSuggestions", () => {
  const items = [item({ id: "m", text: "Milk" }), item({ id: "e", text: "Eggs" })];

  it("suggests a completed item that matches what is typed", () => {
    expect(ids(computeSuggestions(items, "mil"))).toEqual(["m"]);
  });

  it("searches only the segment after the last comma", () => {
    expect(ids(computeSuggestions(items, "eggs, mil"))).toEqual(["m"]);
    expect(computeSuggestions(items, "eggs, ")).toEqual([]);
  });
});
```

d) In `it("AddItemInput searches locally, not via the network", ...)`, replace the regex line with:
```ts
    expect(src).toMatch(/useMemo\(\s*\(\)\s*=>\s*computeSuggestions\(items, value\)/);
```

- [ ] **Step 4: Run it and expect red**

Run `npx vitest run __tests__/unit/search-completed-items.test.ts`. Expected: 3 failures:
- `computeSuggestions > suggests a completed item that matches what is typed`
- `computeSuggestions > searches only the segment after the last comma`
- `source wiring > AddItemInput searches locally, not via the network`

The new signature does not exist yet.

- [ ] **Step 5: Update `__tests__/unit/list-type-switch.test.ts` and `__tests__/unit/grouped-list-wiring.test.ts`**

In `list-type-switch.test.ts`, make five edits.

a) Leave the line `vi.mock("@/components/ReminderSheet", () => ({ default: () => null }));` (HEAD line 64) in place for now. Until Step 8 the page still imports ReminderSheet, and without the mock the test would load the real component, TimePicker and the wheel picker's CSS. Step 8b deletes it.

b) Under the existing `ListHeader` import, add the following. `DragDropProvider` resolves to the mocked `@dnd-kit/react`, and `CompletedItemsSection` to its mock:
```ts
import ListPage from "@/app/list/[id]/page";
import ListHeader from "@/components/list/ListHeader";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import { DragDropProvider } from "@dnd-kit/react";
```

c) Directly above the comment `// Opens the settings sheet and presses the button for a list type.`, add:
```ts
function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (match(el)) out.push(el);
  return findAll(el.props.children, match, out);
}

```

d) The test `it("switching to another type loads no categories", ...)` begins with `chooseType("reminders"); expect(setListType).toHaveBeenCalledWith("reminders");`. Change both strings to `"regular"`:
```ts
  it("switching to another type loads no categories", async () => {
    chooseType("regular");
    expect(setListType).toHaveBeenCalledWith("regular");
```
Keep the rest of that test unchanged.

e) Append at the end of the file:
```ts

describe("the list page", () => {
  it("offers exactly Regular and Grocery in the settings sheet", () => {
    const header = find(render(), (el) => el.type === ListHeader);
    (header!.props.onSettings as () => void)();
    const typeKeys = findAll(render(), (el) => el.type === "button" && typeof el.key === "string" && ["regular", "grocery", "reminders"].includes(el.key)).map((el) => el.key);
    expect(typeKeys).toEqual(["regular", "grocery"]);
  });

  it("renders the drag area and the Done section for a regular list", () => {
    const tree = render();
    expect(find(tree, (el) => el.type === DragDropProvider)).toBeDefined();
    expect(find(tree, (el) => el.type === CompletedItemsSection)).toBeDefined();
  });
});
```

Leave `grouped-list-wiring.test.ts` unchanged for now. Its `vi.mock("@/components/ReminderSheet", ...)` line (HEAD line 116) goes in Step 8b.

- [ ] **Step 6: Run the page tests and expect one red**

Run `npx vitest run __tests__/unit/list-type-switch.test.ts __tests__/unit/grouped-list-wiring.test.ts`. Expected:
- Only `the list page > offers exactly Regular and Grocery in the settings sheet` fails, because the picker still renders a third button.
- `renders the drag area and the Done section` passes at red. It guards the ternary unwrap in Step 8, not the old code.
- The other tests pass: the ReminderSheet mocks are still in place, so the real component is never loaded.

- [ ] **Step 7: Delete the two components and the dependency**

```
git rm components/ReminderSheet.tsx components/TimePicker.tsx
npm uninstall @ncdai/react-wheel-picker
git diff --stat package.json package-lock.json
```
Expected diffstat: `package.json` 1 deletion; `package-lock.json` 13 deletions (the root dependency line plus the `node_modules/@ncdai/react-wheel-picker` block), no additions. If the lockfile shows other changes, revert them with `git checkout package-lock.json` and redo the uninstall. Nothing else imports the package (only `TimePicker.tsx` did, including its `style.css` import).

- [ ] **Step 8: Rewrite `app/list/[id]/page.tsx` with one anchored script**

Run this from the repo root. Every anchor must match exactly once or the script aborts without writing:

```
python3 - <<'PY'
path = "app/list/[id]/page.tsx"
s = open(path).read()


def replace_once(s, old, new):
    assert s.count(old) == 1, f"not unique or missing: {old[:70]!r}"
    return s.replace(old, new)


def cut(s, start, end):
    """Remove from the exact text `start` through the exact text `end`; both must be unique."""
    assert s.count(start) == 1, f"start anchor not unique: {start[:60]!r}"
    a = s.index(start)
    assert s.count(end, a) >= 1, f"end anchor missing: {end[:60]!r}"
    b = s.index(end, a) + len(end)
    return s[:a] + s[b:]


# 1. imports, flag, state
s = replace_once(s, 'import ReminderSheet from "@/components/ReminderSheet";\n', "")
s = replace_once(s, '  const isReminders = listType === "reminders";\n', "")
s = replace_once(
    s,
    "  const [reminderItem, setReminderItem] = useState<string | null>(null);\n"
    "  const [pendingReminderText, setPendingReminderText] = useState<string | null>(null);\n",
    "",
)

# 2. handlers the page no longer uses (the hook keeps exporting them until the handlers task)
s = replace_once(
    s,
    ", handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder } =",
    ", handleRemind, handleReady } =",
)

# 3. the auto-open effect
s = cut(
    s,
    "  // Auto-open ReminderSheet when a newly added item gets its real ID\n",
    "  }, [items, pendingReminderText]);\n\n",
)

# 4. the add box: no list type, no reminder hand-off
s = replace_once(
    s,
    """      <AddItemInput
        listType={listType}
        items={items}
        onAddItem={(text, recycleId) => {
          handleAddItem(text, recycleId);
          // Auto-open ReminderSheet after item syncs in reminders lists
          if (isReminders) {
            setPendingReminderText(text);
          }
        }}
      />
""",
    """      <AddItemInput items={items} onAddItem={handleAddItem} />
""",
)

# 5. unwrap the reminders/regular ternary. The reminders branch goes; the fragment's children
#    become direct children of the scroll container, dedented by 4 spaces. Nothing inside
#    them (the grocery group layout included) changes except indentation.
open_marker = "        {isReminders ? (\n"
branch_end = "        ) : (\n          <>\n"
close_marker = "          </>\n        )}\n"
assert s.count(open_marker) == 1 and s.count(branch_end) == 1 and s.count(close_marker) == 1
a = s.index(open_marker)
b = s.index(branch_end) + len(branch_end)
c = s.index(close_marker)
assert a < b < c
dedented = []
for line in s[b:c].split("\n"):
    if line.strip() == "":
        dedented.append(line)
    else:
        assert line.startswith("    "), f"cannot dedent: {line!r}"
        dedented.append(line[4:])
s = s[:a] + "\n".join(dedented) + s[c + len(close_marker):]

# 6. settings type picker: Regular and Grocery only
s = replace_once(s, '(["regular", "grocery", "reminders"] as const)', '(["regular", "grocery"] as const)')
s = replace_once(
    s,
    """{tp === "regular" ? t('lists.typeRegular') : tp === "grocery" ? t('lists.typeGrocery') : t('lists.typeReminders')}""",
    """{tp === "regular" ? t('lists.typeRegular') : t('lists.typeGrocery')}""",
)

# 7. the ReminderSheet mount
s = cut(s, "      {reminderItem && (() => {\n", "      })()}\n")

# 8. groupByDate, the mid-file imports, ReminderItemsList: everything between the end of
#    ListContent and `export default function ListPage`
a = s.index("// eslint-disable-next-line @typescript-eslint/no-explicit-any\nfunction groupByDate(")
b = s.index("export default function ListPage()")
assert a < b
s = s[:a] + s[b:]

open(path, "w").write(s)
PY
```

Afterwards, check these by eye in `git diff "app/list/[id]/page.tsx"`:
- `listType` still appears for `ListHeader`, the grocery checks, the `useItemHandlers` arg and the settings picker's `listType === tp`.
- The file ends with `export default function ListPage() { ... }` right after `ListContent`'s closing brace.
- `reminderToast`, `setReminderToast` and `<ToastContainer reminderToast={reminderToast}` are untouched (the nudge).
- `SignalSheet onRemind/onReady` is untouched.
- `useEffect` is still used (orchestrator and `fetchItems` effects).
- The `.catch(() => {})` in the type-picker PATCH was already there and is outside this task.

- [ ] **Step 8b: Delete the ReminderSheet mocks now that the component is gone**

In `__tests__/unit/list-type-switch.test.ts` delete `vi.mock("@/components/ReminderSheet", () => ({ default: () => null }));` (HEAD line 64), and in `__tests__/unit/grouped-list-wiring.test.ts` delete the same line (HEAD line 116). A `vi.mock` of a path that no longer exists can fail module resolution. Change nothing else in either file.

Run `npx vitest run __tests__/unit/list-type-switch.test.ts __tests__/unit/grouped-list-wiring.test.ts`. Expected: all pass.

- [ ] **Step 9: Remove the Reminders button from the new-list picker in `app/page.tsx`**

Delete this exact block inside `CreateListSheet`'s segmented control, directly after the Grocery button's closing `</button>` and before the `</div>` that closes the control (HEAD lines 702-709):
```tsx
          <button
            onClick={() => onTypeChange("reminders")}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              listType === "reminders" ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint"
            }`}
          >
            {t('lists.typeReminders')}
          </button>
```
The Regular and Grocery buttons stay. They are `flex-1`, so they split the width evenly.

- [ ] **Step 10: Strip the reminder UI from `components/ItemRow.tsx`**

Make five edits, quoting the text exactly.

a) Lucide import. Change to:
```tsx
import { Check, CircleOff, Clock, Copy, Pencil, Repeat, RotateCcw, Truck, X } from "lucide-react";
```
`Clock` (the pending indicator) and `Repeat` (the grocery repeat toggle) stay.

b) Delete the whole `formatShortTime` helper, from `function formatShortTime(iso: string, tomLabel: string): string {` through its closing `}`, plus one following blank line (HEAD lines 8-21):
```tsx
function formatShortTime(iso: string, tomLabel: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return time;
  if (isTomorrow) return `${tomLabel} ${time}`;
  return d.toLocaleDateString([], { weekday: "short" }) + ` ${time}`;
}

```
After this, `interface ItemRowProps {` follows the import directly, with one blank line between.

c) Delete these four lines from `ItemRowProps`. `onRemoveDuplicates` above them and `isExiting` below them stay:
```tsx
  reminderAt?: string | null;
  recurrence?: string | null;
  onReminderTap?: (id: string) => void;
  isOverdue?: boolean;
```

d) Delete these four lines from the destructure. `onRemoveDuplicates,` above and `isExiting,` below stay:
```tsx
  reminderAt,
  recurrence,
  onReminderTap,
  isOverdue,
```

e) Delete both bell blocks and the blank line that follows them. They run from `{onReminderTap && !completed && (` through the closing `)}` of `{completed && reminderAt && (` (HEAD lines 257-284):
```tsx
      {onReminderTap && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReminderTap(id);
          }}
          className="p-1.5 rounded-full shrink-0 flex items-center gap-1"
        >
          {recurrence ? (
            <span className={`relative shrink-0 ${isOverdue ? "text-amber-500" : reminderAt ? "text-tg-active" : "text-tg-hint"}`}>
              <Bell className={`w-[18px] h-[18px] ${isOverdue ? "bell-pulse" : ""}`} />
              <Repeat className="w-[9px] h-[9px] absolute -bottom-0.5 -right-0.5 stroke-[3]" />
            </span>
          ) : (
            <Bell className={`w-[18px] h-[18px] ${isOverdue ? "text-amber-500 bell-pulse" : reminderAt ? "text-tg-active" : "text-tg-hint"}`} />
          )}
          {reminderAt && (
            <span className={`text-[11px] tracking-wide ${isOverdue ? "text-amber-500" : "text-tg-active"}`}>{formatShortTime(reminderAt, t("tom"))}</span>
          )}
        </button>
      )}
      {completed && reminderAt && (
        <span className="text-[11px] tracking-wide text-tg-hint shrink-0 flex items-center gap-1">
          {recurrence && <Repeat className="w-[10px] h-[10px]" />}
          {formatShortTime(reminderAt, t("tom"))}
        </span>
      )}

```
What must remain: the `{onToggleRecurring && ( ... <Repeat ... /> ... )}` block ends, then one blank line, then the `<button onClick={(e) => { e.stopPropagation(); onDelete(id); }}` delete button.

- [ ] **Step 11: Strip the reminder props from `components/SortableItem.tsx`**

Delete three pairs of lines. Keep `recurring`, `onToggleRecurring`, `onRemoveDuplicates`, `isExiting` and `isJustAdded`, and do not touch the root `<div ref={ref}>`. The pairs are:

In `SortableItemProps`:
```tsx
  reminderAt?: string | null;
  onReminderTap?: (id: string) => void;
```
In the destructure:
```tsx
  reminderAt,
  onReminderTap,
```
In the `<ItemRow ... />` call:
```tsx
        reminderAt={reminderAt}
        onReminderTap={onReminderTap}
```

- [ ] **Step 12: Strip the reminder props from `components/list/CompletedItemsSection.tsx`**

In the done-groups `<ItemRow ... />`, delete these two lines (HEAD 104-105). The `onToggle`, `onDelete` and `onEdit` props around them stay:
```tsx
                  reminderAt={item.my_remind_at}
                  recurrence={item.my_reminder_recurrence}
```

- [ ] **Step 13: Drop `listType` from `components/AddItemInput.tsx`**

a) Replace the props interface head, the component signature and the `useMemo`:
```tsx
interface AddItemInputProps {
  items: ItemData[];
  onAddItem: (text: string, recycleId?: string) => void;
}

export default function AddItemInput({ items, onAddItem }: AddItemInputProps) {
  const t = useTranslations();
  const [value, setValue] = useState("");
  // Only the open/closed flag is state; the list is derived so it can never go stale.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestions = useMemo(
    () => computeSuggestions(items, value),
    [items, value]
  );
```

b) Replace the placeholder line (HEAD 100) with:
```tsx
              placeholder={t('items.addPlaceholder')}
```

- [ ] **Step 14: Simplify `src/utils/search-completed-items.ts`**

a) Delete `shouldSearchWhileTyping` and one following blank line:
```ts
/** Whether the add-item input should suggest completed items while typing. */
export function shouldSearchWhileTyping(listType: "regular" | "reminders" | "grocery"): boolean {
  return listType !== "reminders";
}

```
After this, `function ts(s: string | null)` follows the `Suggestion` interface after one blank line.

b) Replace the doc comment and signature of `computeSuggestions`, down to and including the guard line `if (!shouldSearchWhileTyping(listType)) return [];`, with:
```ts
/**
 * Suggestions for the add-item input: searches only the text after the last comma.
 * Pure so it can be derived from live items.
 */
export function computeSuggestions(items: ItemData[], value: string): Suggestion[] {
```
The three body lines stay: `const segments = value.split(",");`, `const currentSegment = segments[segments.length - 1].trim();`, `return searchCompletedItems(items, currentSegment);`.

- [ ] **Step 15: Delete the bell and wheel-picker CSS and fix the token comment**

Run from the repo root. It aborts without writing if the anchors are off:
```
python3 - <<'PY'
path = "app/globals.css"
s = open(path).read()

start = "\n  .bell-pulse {\n"
last_rule = "  .time-picker-today {\n    color: var(--tg-theme-link-color, oklch(0.55 0.18 247.86));\n    font-weight: 600;\n  }\n"
assert s.count(start) == 1 and s.count(last_rule) == 1
a = s.index(start)
b = s.index(last_rule) + len(last_rule)
assert s[b:].startswith("}\n"), "the utilities layer must close right after the last picker rule"
s = s[:a] + s[b:]

old = "(set reminder, recurring on, etc.)"
assert s.count(old) == 1
s = s.replace(old, "(recurring on, etc.)")
open(path, "w").write(s)
PY
```
This removes `.bell-pulse`, `@keyframes bell-ring`, the `/* DateTime wheel picker */` comment and all `.time-picker*` rules (HEAD 233-316). `@keyframes dropdown-pop` stays, followed directly by the `}` that closes `@layer utilities`, with no blank line between. The `--color-tg-active` token is unchanged; only its comment loses "set reminder".

- [ ] **Step 16: Run the targeted tests and expect green**

Run `npx vitest run __tests__/unit/reminders-ui-removed.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/restore-skipped-wiring.test.ts __tests__/unit/categories-sheet-wiring.test.ts __tests__/unit/list-colors-css.test.ts`. Expected: all pass.

- [ ] **Step 17: Prove the new tests bite (do each by hand, then revert it)**

| Temporary change | Test that must go red |
|---|---|
| Put `"reminders"` back into the `(["regular", "grocery"] as const)` array in `page.tsx` | `list-type-switch > offers exactly Regular and Grocery in the settings sheet` |
| Rename `<DragDropProvider` / `</DragDropProvider>` in `page.tsx` to a `div` (a bad unwrap that loses the drag area) | `list-type-switch > renders the drag area and the Done section for a regular list` |
| Add `Bell` back to the lucide import in `ItemRow.tsx` | `reminders-ui-removed > ItemRow has no bell...` |
| Make the placeholder in `AddItemInput.tsx` `listType ? t('items.addReminderPlaceholder') : t('items.addPlaceholder')` | `reminders-ui-removed > the add box always shows the normal placeholder...` |
| Add `listType={listType}` to `<AddItemInput` in `page.tsx` | `reminders-ui-removed > the add box is not told the list type` |
| Add `.time-picker { height: 1px; }` before `@keyframes dropdown-pop` in `globals.css` | `reminders-ui-removed > globals.css has no bell or wheel-picker rules...` |
| Restore the `listType` first parameter on `computeSuggestions` | `search-completed-items > suggests a completed item...` and `AddItemInput searches locally...` |

All of these were checked on a scratch copy of the repo at HEAD, where each went red as stated.

- [ ] **Step 18: Full gate**

Run these, in this order:
1. `npx vitest run`. Expected: green. The test count is the pre-T5 count plus 10 (new file) plus 2 (list-type-switch additions) minus 2 (search-completed-items drops the `shouldSearchWhileTyping` test and the reminders-empty test). That is a net of +10. On a scratch copy of HEAD, 550 became 560, and T1-T4 shift the starting number.
2. `npx tsc --noEmit`. Expected: no output.
3. `npx eslint "app/list/[id]/page.tsx" app/page.tsx components/ItemRow.tsx components/SortableItem.tsx components/list/CompletedItemsSection.tsx components/AddItemInput.tsx src/utils/search-completed-items.ts __tests__/unit/reminders-ui-removed.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/grouped-list-wiring.test.ts`. Expected: no output.

- [ ] **Step 19: Commit**

```
git add -A components app src __tests__ package.json package-lock.json
git commit -m "refactor(client): remove the reminders list view, sheet, picker and row UI

Delete ReminderSheet, TimePicker and the wheel-picker dependency. The list
page loses the reminders branch (grocery group layout unchanged), the
auto-open effect and the Reminders choice in both type pickers. Item rows
lose the bell, time label and overdue state. The add box always shows the
normal placeholder, and search-while-typing has no reminders exception.
Drop the bell-pulse and time-picker CSS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

BOUNDARY NOTE:
- **Page destructure moved forward.** I removed `handleSetReminder`, `handleUpdateReminder` and `handleCancelReminder` from the page's `useItemHandlers` destructure in this task, not T6. The ReminderSheet mount was their only use, so leaving them would trip the unused-variable lint. T6 only has to delete the handlers inside the hook, not in the page. The page still passes `listType` to `useItemHandlers`, and T6 removes that.
- **Type-switch test lines moved forward.** The `chooseType("reminders")` lines in `list-type-switch.test.ts` (~153-154) had to change in T5, not T7, because the settings picker no longer has a "reminders" button. The old test would fail at `expect(button).toBeDefined()`. T7 has no work left in that file.
- **Locale keys left for T9.** These are now unused but stay in the locale files: `lists.typeReminders`, `items.addReminderPlaceholder`, `items.tom`, `items.overdue` and the group labels. `locale-parity` stays green.
- **Data fields left for T6.** `ItemData.my_remind_at` and the other `my_reminder_*` fields stay until then.
- **`ListType` unchanged.** It still includes `"reminders"` until T7. The page's `listType` flows into `ListHeader` and `useItemHandlers` unchanged.
- **Scratch-copy caveat.** I verified Steps 1-18 on a scratch copy of the repo at HEAD, so T1-T4 changes were not applied there. `npm uninstall` also rewrote a scratch `node_modules` there, not the real one.

---

### Task 6: Client data, handlers and offline replay without reminders

**Files:**
- Modify: `src/types/items.ts`
- Modify: `src/hooks/useListData.ts`
- Modify: `src/hooks/useItemHandlers.ts`
- Modify: `src/utils/executor-factory.ts`
- Modify: `app/list/[id]/page.tsx`
- Modify: `__tests__/unit/executor-factory.test.ts`
- Modify: `__tests__/unit/list-data-categories.test.ts`
- Modify: `__tests__/unit/restore-skipped-flow.test.ts`
- Modify: `__tests__/unit/mutation-request-parity.test.ts` (comments only)
- No change: `src/types/mutations.ts`. Its `toggle` variant is already `{ type: "toggle"; listId; itemId; completed }`. The `remindAt`/`recurrence`/`isShared` keys were never in the type, because `QueuedMutation.payload` is `Record<string, unknown>`.

**Interfaces:**
- Consumes:
  - From T3: the `complete-recurring`, `.../reminder`, `.../reminder/[reminderId]` and `/api/lists/[id]/reminders` routes are deleted.
  - From T5: nothing in `app/` or `components/` reads `my_remind_at` / `my_reminder_*` any more. That means the ReminderSheet mount, `groupByDate`, `ReminderItemsList`, and the `reminderAt`/`recurrence` row props are all gone.
- Produces:
  - `UseItemHandlersParams` has no `listType` field.
  - `useItemHandlers(...)` returns exactly `{ handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRestoreSkipped, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady }`.
  - `ItemData` has no `my_remind_at`, `my_reminder_id`, `my_reminder_shared` or `my_reminder_recurrence`.
  - The online toggle payload is always `{ listId, itemId, completed }`.
  - The `toggle` case in `createExecutorFactory()` always sends `PATCH /api/lists/${listId}/items` with body `{ itemId, completed }` and ignores any other payload keys.
  - `useListData` still exposes `listType` typed `"regular" | "reminders" | "grocery"`. T7 narrows it.

- [ ] **Step 1: Write the failing replay test in `__tests__/unit/executor-factory.test.ts`**

Replace the whole block from the line `// Regression: a "toggle" mutation queued while offline for a recurring Done tap` (HEAD line 42) through the `});` that closes `describe("createExecutorFactory - toggle routing", ...)` (HEAD line 110, just above `// "Restore all" on the Not available section`) with:

```ts
// Offline replay of a toggle is a plain PATCH to the items route. A toggle queued
// by an older version of the app (the queue keeps mutations for up to 24 hours) can
// still carry remindAt / recurrence / isShared in its stored payload. Those keys
// must be ignored: the item is marked done and nothing is sent to the removed
// complete-recurring route, which would 404 and make the queue drop the tap.
describe("createExecutorFactory - toggle", () => {
  const factory = createExecutorFactory();
  const getJwt = () => "jwt";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a plain toggle payload to the items PATCH", async () => {
    const mutation: QueuedMutation = {
      id: "m2",
      type: "toggle",
      payload: { listId: "l1", itemId: "i1", completed: true },
      timestamp: 0,
    };

    const executor = factory(mutation, getJwt);
    await executor!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
  });

  it("replays a stale queued toggle that still carries remindAt/recurrence as a plain PATCH", async () => {
    const mutation: QueuedMutation = {
      id: "m1",
      type: "toggle",
      payload: {
        listId: "l1",
        itemId: "i1",
        completed: true,
        remindAt: "2026-09-20T04:30:00.000Z",
        recurrence: "weekly",
        isShared: false,
      },
      timestamp: 0,
    };

    const executor = factory(mutation, getJwt);
    await executor!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", completed: true });
  });
});
```

Leave `REPLAYABLE_TYPES` unchanged. It must still list `"set-recurring"` and `"restore-recurring"`, which belong to the grocery repeat feature.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run __tests__/unit/executor-factory.test.ts`

Expected: 1 failure, in `replays a stale queued toggle that still carries remindAt/recurrence as a plain PATCH`. The failure reads `expected '/api/lists/l1/items/i1/complete-recurring' to be '/api/lists/l1/items'`. Every other test passes. The test count stays at 19: one test was deleted and one added.

What turns it red: the `if (payload.recurrence && payload.remindAt) { ... complete-recurring ... }` branch in the factory's `toggle` case.

- [ ] **Step 3: Write the failing data-loading test in `__tests__/unit/list-data-categories.test.ts`**

3a. Inside `stubFetch` (HEAD line 41), delete this line:

```ts
    if (url.startsWith("/api/lists/L/reminders")) return json({ reminders: [] });
```

3b. Inside `stubServer` (HEAD line 163), delete this line:

```ts
        if (url.startsWith("/api/lists/L/reminders")) return json({ reminders: [] });
```

Once both lines are gone, any `/reminders` request hits the stub's `throw new Error(\`unexpected ${url}\`)`.

3c. Append at the end of the file, after the final `});`:

```ts
// Reminders were removed: opening or refreshing a list asks only for the list, its
// items and (on a grocery list) its categories, and no item carries reminder fields.
describe("useListData item loading", () => {
  it("never asks for reminders when a list opens or refreshes", async () => {
    for (const type of ["regular", "grocery"]) {
      R.slots = [];
      const f = stubFetch([], type);
      await render().fetchItems();
      await render().refreshItems();

      const urls = f.mock.calls.map(([url]) => url);
      expect(urls.filter((u) => u.includes("/reminders"))).toEqual([]);
      expect(render().error).toBe(false);
      expect(render().items.map((i) => i.id)).toEqual(["a"]);
    }
  });

  it("maps fetched and refreshed items without any reminder fields", async () => {
    stubFetch([], "regular");
    await render().fetchItems();
    const fetched = render().items[0] as unknown as Record<string, unknown>;
    await render().refreshItems();
    const refreshed = render().items[0] as unknown as Record<string, unknown>;

    for (const item of [fetched, refreshed]) {
      expect(item.id).toBe("a");
      expect(Object.keys(item).filter((k) => k.startsWith("my_remind"))).toEqual([]);
    }
  });
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `npx vitest run __tests__/unit/list-data-categories.test.ts`

Expected: both new tests fail.
- `never asks for reminders...` fails because `urls` contains `/api/lists/L/reminders`.
- `maps fetched and refreshed items...` fails because the stub throws on `/reminders`, `fetchItems` sets `error` and never sets the items, so `render().items[0]` is undefined and the test throws reading `.id`.

Most existing tests in the file also go red for the same reason: `still opens the list...`, `loads a grocery list's categories...`, the refresh tests, the `loadCategories` tests that need a prior fetch, and `retrySorting` `copies in...`. That is expected at this step.

What turns them red:
- either `/reminders` fetch in `fetchItems` or `refreshItems`;
- for the second test, also the `my_remind_at` / `my_reminder_*` keys in either map.

- [ ] **Step 5: Remove the reminder fields from `ItemData` in `src/types/items.ts`**

Delete these four lines (HEAD 17-20):

```ts
  my_remind_at?: string | null;
  my_reminder_id?: string | null;
  my_reminder_shared?: boolean;
  my_reminder_recurrence?: string | null;
```

Afterwards, `editor_name: string | null;` is followed directly by `_pending?: boolean;`.

- [ ] **Step 6: Remove the reminder fetches and fields from `src/hooks/useListData.ts`**

6a. Delete the `Reminder` type and `pickPreferredReminder` (HEAD 9-27), from `type Reminder = {` through the closing `}` of `function pickPreferredReminder(...)`, and the blank line after it. The file then goes straight from `import { sortCategories } from "@/src/utils/category-state";` and one blank line to the `// The list cap is 500` comment.

6b. Replace the cap comment (HEAD 29-35), which still names the deleted `src/services/recurring.ts`:

```ts
// The list cap is 500 non-deleted items (insert_item_if_under_limit uses the same
// predicate as GET /items), so limit=500 covers every normal case. It is a cap, not a
// guarantee: the voice insert (src/services/voice-handler.ts), the recurring successor
// insert (src/services/recurring.ts) and the PATCH undo-restore
// (app/api/lists/[id]/items/route.ts) bypass the cap RPC, so a list can exceed 500 and
// GET then drops the lowest positions. The route defaults to 200 and we ignore
// nextCursor, which would silently truncate.
```

with:

```ts
// The list cap is 500 non-deleted items (insert_item_if_under_limit uses the same
// predicate as GET /items), so limit=500 covers every normal case. It is a cap, not a
// guarantee: the voice insert (src/services/voice-handler.ts) and the PATCH
// undo-restore (app/api/lists/[id]/items/route.ts) bypass the cap RPC, so a list can
// exceed 500 and GET then drops the lowest positions. The route defaults to 200 and we
// ignore nextCursor, which would silently truncate.
```

6c. In `fetchItems`, delete the reminders fetch block (HEAD 117-131), from `        // Fetch reminders for all items in this list` through the closing `        }` of `if (remindersRes.ok) { ... }`. What remains is:

```ts
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const now = Date.now();

        const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string; skipped_at?: string | null; recurring?: boolean; completed?: boolean; completed_at?: string | null; deleted_at?: string | null }) => {
```

6d. In the same map, replace:

```ts
          const reminder = remindersByItem.get(item.id as string);
          const base = {
            ...item,
            creator_name: item.users?.name ?? null,
            editor_name: item.editor?.name ?? null,
            _pending: false,
            users: undefined,
            editor: undefined,
            my_remind_at: reminder?.remind_at ?? null,
            my_reminder_id: reminder?.id ?? null,
            my_reminder_shared: reminder?.is_shared ?? false,
            my_reminder_recurrence: reminder?.recurrence ?? null,
          };
```

with:

```ts
          const base = {
            ...item,
            creator_name: item.users?.name ?? null,
            editor_name: item.editor?.name ?? null,
            _pending: false,
            users: undefined,
            editor: undefined,
          };
```

Keep all of these unchanged: the auto-unskip, the `shouldRespawn` auto-respawn (the `restoreRecurring: true` PATCH), `setItems(mapped)` and `if (currentListType === "grocery") await loadCategories();`.

6e. In `refreshItems`, replace (HEAD 200-229):

```ts
      // Re-fetch reminders so items keep their reminder data after reconnect
      const remindersUrl = listType === "reminders"
        ? `/api/lists/${listId}/reminders?include_sent=1`
        : `/api/lists/${listId}/reminders`;
      const remindersRes = await fetch(remindersUrl, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const remindersByItem = new Map<string, Reminder>();
      if (remindersRes.ok) {
        const { reminders } = await remindersRes.json();
        for (const r of reminders || []) {
          remindersByItem.set(r.item_id, pickPreferredReminder(remindersByItem.get(r.item_id), r));
        }
      }

      const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        const reminder = remindersByItem.get(item.id);
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
          my_remind_at: reminder?.remind_at ?? null,
          my_reminder_id: reminder?.id ?? null,
          my_reminder_shared: reminder?.is_shared ?? false,
          my_reminder_recurrence: reminder?.recurrence ?? null,
        };
      });
```

with:

```ts
      const mapped = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
        };
      });
```

Keep `listType` in the `refreshItems` deps `[jwtRef, listId, listType, loadCategories]`. It is still read by `if (listType === "grocery") await loadCategories();`.

Leave the two `"regular" | "reminders" | "grocery"` unions (HEAD lines 45 and 104) alone. T7 narrows them.

- [ ] **Step 7: Run the data test and see it pass**

Run: `npx vitest run __tests__/unit/list-data-categories.test.ts`

Expected: all tests pass (2 more than before this task).

- [ ] **Step 8: Remove the recurring-done branch from `src/utils/executor-factory.ts`**

Replace the whole `case "toggle":` block (HEAD 28-68), from `      case "toggle":` through the `        };` just before `      case "delete":`, with:

```ts
      case "toggle":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
        };
```

Leave every other case unchanged, especially `set-recurring` and `restore-recurring`.

- [ ] **Step 9: Run the replay test and see it pass**

Run: `npx vitest run __tests__/unit/executor-factory.test.ts`

Expected: 19 passed.

- [ ] **Step 10: See the parity test catch the half-done change**

Run: `npx vitest run __tests__/unit/mutation-request-parity.test.ts`

Expected: 1 failure, in `"toggle": online and replay send the same request(s)`. The inline side (useItemHandlers.ts) still lists `POST /api/lists/{}/items/{}/complete-recurring, PATCH /api/lists/{}/items` while the factory now lists only `PATCH /api/lists/{}/items`. This is the safety net that makes both sides change in the same commit. Step 11 turns it green.

- [ ] **Step 11: Remove the reminder handlers, the recurring-done path and the `listType` prop from `src/hooks/useItemHandlers.ts`**

11a. In `interface UseItemHandlersParams`, delete this line (HEAD 27):

```ts
  listType?: "regular" | "reminders" | "grocery";
```

11b. In the destructured parameters of `export function useItemHandlers({`, delete this line (HEAD 42):

```ts
  listType,
```

The destructure then ends `setReminderToast,`, `setErrorToast,`, `t,`, `}: UseItemHandlersParams) {`.

11c. In `handleAddItem`, replace (HEAD 113-125):

```ts
      // Check for duplicate (skip in reminders lists — duplicates are expected)
      if (listType !== "reminders") {
        const normalized = normalizeForCompare(text);
        const existing = items.find(
          (i) => !i.completed && !i.deleted_at && !i.skipped_at && normalizeForCompare(i.text) === normalized
        );
        if (existing) {
          const tg = getTelegramWebApp();
          tg?.HapticFeedback?.notificationOccurred("warning");
          setDuplicateWarning(t("items.duplicateWarning"));
          setTimeout(() => setDuplicateWarning(null), 2500);
        }
      }
```

with:

```ts
      // Check for duplicate
      const normalized = normalizeForCompare(text);
      const existing = items.find(
        (i) => !i.completed && !i.deleted_at && !i.skipped_at && normalizeForCompare(i.text) === normalized
      );
      if (existing) {
        const tg = getTelegramWebApp();
        tg?.HapticFeedback?.notificationOccurred("warning");
        setDuplicateWarning(t("items.duplicateWarning"));
        setTimeout(() => setDuplicateWarning(null), 2500);
      }
```

Keep the `handleAddItem` deps array `[jwtRef, listId, addMutation, addSingleItem, items, t, userId, setItems, setDuplicateWarning]` unchanged. This also clears the existing `react-hooks/exhaustive-deps` warning about the missing `listType` dependency.

11d. Replace the whole `handleToggle` (HEAD 171-285), from `  const handleToggle = useCallback(` through `    [jwtRef, listId, listType, items, addMutation, setItems]` and its closing `  );`, with:

```ts
  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // Animate out then update
      if (completed) {
        setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, _exiting: true } : i));
        await new Promise((r) => setTimeout(r, 200));
      }

      // Optimistic
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                completed,
                completed_at: completed ? new Date().toISOString() : null,
                _exiting: false,
              }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "toggle",
        payload: { listId, itemId, completed },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, completed }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Toggle failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );
```

This removes:
- the `const item = items.find(...)` lookup, which only the reminder code read;
- `isRecurringDone` and its comment;
- the `remindAt`/`recurrence`/`isShared` payload spread;
- the `complete-recurring` POST and `recurBody` handling;
- the successor `setItems` insert;
- `items` and `listType` from the deps.

11e. Delete the three reminder handlers (HEAD 767-859), from `  const handleSetReminder = useCallback(` through the `    [jwtRef, listId, setItems, setReminderToast]` line and its closing `  );` that end `handleUpdateReminder`. This removes `handleSetReminder`, `handleCancelReminder` and `handleUpdateReminder`, including the `t("reminder.sent")` / `t("reminder.cancelled")` toasts and their `console.error` logs.

What must remain right above the `return` is `handleReady`:

```ts
  const handleReady = useCallback(
    () => sendSignal("ready", "items.readySent"),
    [sendSignal]
  );
```

Keep `sendSignal`, `handleRemind` and the `setReminderToast` prop. They belong to the Remind/Ready nudge.

11f. Replace the return line (HEAD 861):

```ts
  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRestoreSkipped, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder };
```

with:

```ts
  return { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRestoreSkipped, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady };
```

- [ ] **Step 12: Stop passing `listType` and taking the removed handlers in `app/list/[id]/page.tsx`**

12a. Replace the destructure line directly above `    useItemHandlers({`. It starts `  const { handleAddItem, handleToggle,` (HEAD line 127). At HEAD it still ends `handleReady, handleSetReminder, handleUpdateReminder, handleCancelReminder } =`; T5 may already have trimmed it. Whatever is there, the line must become exactly:

```tsx
  const { handleAddItem, handleToggle, handleDelete, handleEditItem, handleSkip, handleRestoreSkipped, handleOrder, handleSetRecurring, handleRestoreRecurring, handleRemoveDuplicates, handleClearCompleted, handleUnmarkAllDone, handleRemind, handleReady } =
```

12b. In the `useItemHandlers({ ... })` argument object, replace:

```tsx
      setErrorToast,
      listType,
      t: t as (key: string, values?: Record<string, unknown>) => string,
```

with:

```tsx
      setErrorToast,
      t: t as (key: string, values?: Record<string, unknown>) => string,
```

`listType` from `useListData` stays in the page. ListHeader, the grocery checks and the settings picker still read it.

- [ ] **Step 13: Remove the dead `listType` argument from `__tests__/unit/restore-skipped-flow.test.ts`**

The `as unknown as Parameters<typeof useItemHandlers>[0]` cast hides the removed prop from tsc, so this has to be done by hand. Replace:

```ts
      setDuplicateWarning: noop, setReminderToast: noop, setErrorToast: noop,
      listType: "grocery", t,
```

with:

```ts
      setDuplicateWarning: noop, setReminderToast: noop, setErrorToast: noop,
      t,
```

Keep `setReminderToast: noop`, which belongs to the nudge.

- [ ] **Step 14: Update the stale comments in `__tests__/unit/mutation-request-parity.test.ts`**

14a. Replace (HEAD 13-17):

```ts
// This already happened in production: the "toggle" case POSTed to
// /complete-recurring when online but did a plain PATCH /items on replay.
// Tapping Done on a recurring reminder while offline, then reopening the app,
// marked the item complete and never created the next occurrence -- silently
// ending the user's recurring series. Fixed in 5f3dd51.
```

with:

```ts
// This already happened in production (fixed in 5f3dd51): one mutation type
// sent one request online and a different one on replay, so a tap made offline
// did something else once the app was reopened, and the queue still reported
// success. The feature involved is gone; the class of bug is not.
```

14b. Replace (HEAD 30-31) the reference to the test file T2 deleted:

```ts
// source-inspection test (pattern: recycle-scoping.test.ts,
// no-deleted-item-leak.test.ts, reminder-callback-auth.test.ts) rather than a
```

with:

```ts
// source-inspection test (pattern: recycle-scoping.test.ts,
// no-deleted-item-leak.test.ts, restore-skipped-wiring.test.ts) rather than a
```

14c. Replace (HEAD 233):

```ts
          `bug fixed in 5f3dd51 (recurring "toggle" silently ending the series on replay).\n` +
```

with:

```ts
          `bug fixed in 5f3dd51 (a mutation sending one request online and another on replay).\n` +
```

Do not change any extraction logic.

- [ ] **Step 15: Run the touched test files and see them pass**

Run: `npx vitest run __tests__/unit/mutation-request-parity.test.ts __tests__/unit/executor-factory.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/restore-skipped-wiring.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/list-type-switch.test.ts`

Expected: all pass. The parity test stays at 14 tests (2 sanity checks plus 12 types), and `"toggle"` now shows `PATCH /api/lists/{}/items` on both sides.

- [ ] **Step 16: Check that no reminder data path is left in the client data layer**

Run: `git grep -n "my_remind\|my_reminder\|complete-recurring\|handleSetReminder\|handleUpdateReminder\|handleCancelReminder\|pickPreferredReminder\|isRecurringDone" -- src app components`

Expected: no output.

Run: `git grep -n "reminders" -- src/hooks src/utils/executor-factory.ts src/types/items.ts`

Expected: exactly the two `useListData.ts` lines with `"regular" | "reminders" | "grocery"` (the `useState` and the `setListType` cast), which T7 narrows.

- [ ] **Step 17: Run the gate**

Run: `npx vitest run`
Expected: all green, with 2 more passing tests than after T5. executor-factory.test.ts stays at 19 (1 deleted, 1 added). list-data-categories.test.ts gains 2. No test files are added or deleted.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/types/items.ts src/hooks/useListData.ts src/hooks/useItemHandlers.ts src/utils/executor-factory.ts "app/list/[id]/page.tsx" __tests__/unit/executor-factory.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/mutation-request-parity.test.ts`
Expected: 0 errors. The HEAD warning `useItemHandlers.ts 168:5 React Hook useCallback has a missing dependency: 'listType'` is gone, and no new `no-unused-vars` warning appears for `item`, `items` or the removed handlers.

- [ ] **Step 18: Commit**

```bash
git add src/types/items.ts src/hooks/useListData.ts src/hooks/useItemHandlers.ts src/utils/executor-factory.ts "app/list/[id]/page.tsx" __tests__/unit/executor-factory.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/mutation-request-parity.test.ts
git commit -m "$(cat <<'EOF'
refactor: drop reminder data, handlers and replay from the list client

useListData no longer fetches /reminders and items carry no my_reminder_*
fields. useItemHandlers loses the set/update/cancel reminder handlers, the
recurring Done path through complete-recurring and its listType prop. The
offline executor's toggle case is now always a plain PATCH, so a toggle
queued by an older app with remindAt/recurrence still marks the item done.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

BOUNDARY NOTE:
- **T5 must leave no `my_remind_at` or `my_reminder_*` reader.** Step 5 removes those `ItemData` fields, so if T5 left any reader in `app/` or `components/` (for example `reminderAt={item.my_remind_at}` in `CompletedItemsSection.tsx`, or the ReminderSheet mount in `page.tsx`), `npx tsc --noEmit` goes red. That cleanup belongs to T5, not here.
- **T10's leftover grep needs two test files on its allow-list.** The new tests in `__tests__/unit/executor-factory.test.ts` deliberately contain `remindAt`, `recurrence` and `complete-recurring`. The new tests in `__tests__/unit/list-data-categories.test.ts` deliberately contain `/reminders` and `my_remind`. Each test checks that one of these is absent or ignored.

---

### Task 7: Narrow the list type to regular and grocery

**Files:**
- Modify: `src/schemas/lists.ts`
- Modify: `src/lib/list-icons.ts`
- Modify: `src/hooks/useListData.ts`
- Modify: `__tests__/unit/list-type-switch.test.ts`
- Modify: `__tests__/unit/list-data-categories.test.ts`
- Create: `__tests__/unit/list-type-narrowing.test.ts`

**Interfaces:**
- Consumes (already done by T5 and T6):
  - T5 removed the Reminders button from `app/page.tsx` and from the settings picker in `app/list/[id]/page.tsx`.
  - T5 also removed the `lists.typeReminders` ternary arm in that picker.
  - T6 deleted the two `/reminders` fetches and the `my_reminder_*` fields in `useListData`.
- Produces:
  - `listTypeEnum = z.enum(["regular","grocery"])` in `src/schemas/lists.ts`.
  - `type ListType = "regular" | "grocery"` in `src/lib/list-icons.ts`.
  - `defaultIconFor` and `defaultColorFor` with no reminders arm.
  - `useListData` returns `listType: ListType` and `setListType: Dispatch<SetStateAction<ListType>>`.
  - A stored `"reminders"` type is read as `"regular"` on the client.

- [ ] **Step 1: Confirm the client no longer offers the reminders type**

Run: `git grep -nE "[\"']reminders[\"']" -- app components src`
Expected: the only remaining hits are `src/schemas/lists.ts:4`, `src/lib/list-icons.ts:138` (the `ListType` union), `src/lib/list-icons.ts:141`, `src/lib/list-icons.ts:144` and the `"reminders"` unions in `src/hooks/useListData.ts` (about lines 45 and 104). Any hit in `app/page.tsx`, `app/list/[id]/page.tsx` or `components/` means T5 is incomplete (see BOUNDARY NOTE).

- [ ] **Step 2: Write the failing schema and defaults test**

Create `__tests__/unit/list-type-narrowing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createListSchema, updateListSchema, listTypeEnum } from "@/src/schemas/lists";
import {
  LIST_COLORS,
  LIST_ICONS,
  defaultColorFor,
  defaultIconFor,
  listAccentVar,
  resolveIcon,
  type ListType,
} from "@/src/lib/list-icons";

// The reminders list type was removed. Migration 029 later retires the value in the database,
// so until then a list an old app version made during the deploy can still carry it.

const LIST_ID = "0b8f6c1e-2f4a-4c3b-9d1e-000000000001";

// @ts-expect-error "reminders" is no longer a ListType, so this line must not compile
const retired: ListType = "reminders";
void retired;

describe("list type schemas", () => {
  it("offer exactly regular and grocery", () => {
    expect(listTypeEnum.options).toEqual(["regular", "grocery"]);
  });

  it("create rejects the reminders type", () => {
    expect(createListSchema.safeParse({ name: "Chores", type: "reminders" }).success).toBe(false);
  });

  it("update rejects the reminders type", () => {
    expect(updateListSchema.safeParse({ id: LIST_ID, type: "reminders" }).success).toBe(false);
  });

  it("still accept regular, grocery and no type at all", () => {
    expect(createListSchema.safeParse({ name: "Chores" }).success).toBe(true);
    expect(createListSchema.safeParse({ name: "Food", type: "grocery" }).success).toBe(true);
    expect(updateListSchema.safeParse({ id: LIST_ID, type: "regular" }).success).toBe(true);
  });
});

describe("list type defaults", () => {
  it("a list still stored as reminders gets the regular icon and colour", () => {
    const stale = "reminders" as unknown as ListType;
    expect(defaultIconFor(stale)).toBe("ListChecks");
    expect(defaultColorFor(stale)).toBe("slate");
    expect(resolveIcon(null, stale)).toBe(LIST_ICONS.ListChecks);
    expect(listAccentVar(null, stale)).toBe("var(--list-slate)");
  });

  it("keeps grocery and regular defaults", () => {
    expect(defaultIconFor("grocery")).toBe("ShoppingCart");
    expect(defaultColorFor("grocery")).toBe("emerald");
    expect(defaultIconFor("regular")).toBe("ListChecks");
    expect(defaultColorFor("regular")).toBe("slate");
  });

  it("keeps the Bell icon and the blue colour as picks for any list", () => {
    expect(resolveIcon("Bell", "regular")).toBe(LIST_ICONS.Bell);
    expect(LIST_COLORS).toContain("blue");
  });
});
```

- [ ] **Step 3: Write the failing client test for a stored reminders type**

In `__tests__/unit/list-data-categories.test.ts`, inside `describe("useListData categories", ...)`, insert this test directly above the line `it("loads a grocery list's categories in walk order", async () => {`:

```ts
  it("opens a list still stored with the retired reminders type as a regular list", async () => {
    // An old app version can create one during the deploy window; migration 029 retires the value.
    const f = stubFetch([], "reminders");
    await render().fetchItems();
    expect(render().listType).toBe("regular");
    expect(f.mock.calls.map(([url]) => url)).not.toContain("/api/lists/L/categories");
  });

```

- [ ] **Step 4: Run both tests and the type check, and confirm they fail**

Run: `npx vitest run __tests__/unit/list-type-narrowing.test.ts __tests__/unit/list-data-categories.test.ts`
Expected: 5 failures:
- "offer exactly regular and grocery" (received `['regular','reminders','grocery']`).
- "create rejects the reminders type".
- "update rejects the reminders type".
- "a list still stored as reminders gets the regular icon and colour" (received `'Bell'`).
- "opens a list still stored with the retired reminders type as a regular list" (received `'reminders'`).

The other tests in both files pass.

Run: `npx tsc --noEmit`
Expected: one error, `__tests__/unit/list-type-narrowing.test.ts(18,1): error TS2578: Unused '@ts-expect-error' directive.`

- [ ] **Step 5: Narrow the zod enum**

In `src/schemas/lists.ts`, replace line 4:

```ts
export const listTypeEnum = z.enum(["regular", "reminders", "grocery"]);
```

with:

```ts
export const listTypeEnum = z.enum(["regular", "grocery"]);
```

Nothing else in the file changes.

- [ ] **Step 6: Narrow `ListType` and its defaults**

In `src/lib/list-icons.ts`, replace this block (HEAD lines 138-144):

```ts
export type ListType = "regular" | "reminders" | "grocery";

export const defaultIconFor = (t: ListType): ListIconName =>
  t === "grocery" ? "ShoppingCart" : t === "reminders" ? "Bell" : "ListChecks";

export const defaultColorFor = (t: ListType): ListColor =>
  t === "grocery" ? "emerald" : t === "reminders" ? "blue" : "slate";
```

with:

```ts
export type ListType = "regular" | "grocery";

export const defaultIconFor = (t: ListType): ListIconName =>
  t === "grocery" ? "ShoppingCart" : "ListChecks";

export const defaultColorFor = (t: ListType): ListColor =>
  t === "grocery" ? "emerald" : "slate";
```

Keep the `Bell` import and the `Bell` entry in `LIST_ICONS`: the nudge uses the icon and users can still pick it. Keep `"blue"` in `LIST_COLORS`.

- [ ] **Step 7: Type `useListData` with `ListType` and read a stored reminders type as regular**

In `src/hooks/useListData.ts` make four edits.

1. Replace the import `import type { ListColor, ListIconName } from "@/src/lib/list-icons";` with:

```ts
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";
```

2. Replace `const [listType, setListType] = useState<"regular" | "reminders" | "grocery">("regular");` with:

```ts
  const [listType, setListType] = useState<ListType>("regular");
```

3. Replace `let currentListType: string = "regular";` with:

```ts
      let currentListType: ListType = "regular";
```

4. Replace these two lines:

```ts
        currentListType = currentList.type ?? "regular";
        setListType(currentListType as "regular" | "reminders" | "grocery");
```

with:

```ts
        // A list an old app version created with the retired reminders type during the deploy window reads as a
        // regular list until migration 029 retires the value.
        currentListType = currentList.type === "grocery" ? "grocery" : "regular";
        setListType(currentListType);
```

`ListSummary.type` stays `string`. `if (currentListType === "grocery") await loadCategories();` stays.

- [ ] **Step 8: Update the type-switch test, only if T5 has not already done it**

Run: `git grep -n 'chooseType("reminders")' -- __tests__`
- No output: T5 already changed it, skip this step.
- A hit in `__tests__/unit/list-type-switch.test.ts` (HEAD lines 152-154): replace the whole test with:

```ts
  it("switching to regular loads no categories", async () => {
    chooseType("regular");
    expect(setListType).toHaveBeenCalledWith("regular");
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).not.toHaveBeenCalled();
  });
```

Then run: `git grep -n "ReminderSheet" -- __tests__`
Expected: no output.

- [ ] **Step 9: Run the new tests and confirm they pass**

Run: `npx vitest run __tests__/unit/list-type-narrowing.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-type-switch.test.ts`
Expected: all pass (7 + 12 + 3 tests; list-data-categories has one more than before).

Which production change turns each test red:
- **Schema tests:** putting `"reminders"` back into `listTypeEnum` turns "offer exactly...", "create rejects..." and "update rejects..." red.
- **"a list still stored as reminders..." test:** restoring either `t === "reminders"` arm in `defaultIconFor` or `defaultColorFor` turns it red.
- **`@ts-expect-error` line:** widening `ListType` again fails `tsc` with TS2578.
- **useListData test:** reverting step 7.4 to `currentList.type ?? "regular"` turns it red.

- [ ] **Step 10: Run the full gate**

Run: `npx vitest run`
Expected: all green, previous total + 8 tests (7 new file, 1 in list-data-categories; no file count change other than +1).

Run: `npx tsc --noEmit`
Expected: no output. Any error about `"reminders"` not assignable to `ListType` is a leftover from T5 or T6 (see BOUNDARY NOTE).

Run: `npx eslint src/schemas/lists.ts src/lib/list-icons.ts src/hooks/useListData.ts __tests__/unit/list-type-narrowing.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-type-switch.test.ts`
Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add src/schemas/lists.ts src/lib/list-icons.ts src/hooks/useListData.ts __tests__/unit/list-type-narrowing.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-type-switch.test.ts
git commit -m "refactor(lists): narrow the list type to regular and grocery

The reminders list type is gone: the zod enum, ListType and the icon and
colour defaults offer only regular and grocery. A list an old app version
made as reminders during the deploy window opens as a regular list.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

BOUNDARY NOTE: T5's brief lists list-type-switch only for its `vi.mock` line, but once T5 removes the `reminders` button, `chooseType("reminders")` at HEAD lines 152-154 fails its "the reminders button" assertion. T5 must also fix those lines, or list-type-switch is red at the end of T5 (step 8 here then skips). T5 must also drop the `lists.typeReminders` ternary arm at `app/list/[id]/page.tsx:431` and the `"reminders"` entry at line 410. If either survives, `tsc` goes red in step 10 (`"reminders"` not assignable to `ListType`) and the Task 9 key guard goes red.

---

### Task 8: Stop syncing and accepting the time zone

**Files:**
- Modify: `components/TelegramProvider.tsx`
- Modify: `src/schemas/user.ts`
- Modify: `app/api/user/route.ts`
- Create: `__tests__/unit/user-update.test.ts`

**Interfaces:**
- Consumes: T2 deleted `app/api/cron/digest/route.ts` and the bot snooze branch, and T4 removed the voice timezone read. After this task nothing reads or writes `users.timezone`. The column stays until T11 drops it.
- Produces: `updateUserSchema = z.object({ language: z.enum(["en", "he", "ru"]) })`. Language is required, and an unknown `timezone` key is stripped (zod's default for `z.object`). PATCH `/api/user` writes only `language`. The only remaining PATCH sender, `src/hooks/useLocaleSync.ts`, already sends `{ language }`.

- [ ] **Step 1: Write the failing test file `__tests__/unit/user-update.test.ts`**
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { readFileSync } from "fs";
  import { resolve } from "path";
  import { NextRequest } from "next/server";

  // Runs the real PATCH handler; auth, the rate limiter and Supabase are faked.
  const h = vi.hoisted(() => ({
    calls: [] as { table: string; values: unknown; filters: string[] }[],
  }));

  vi.mock("@/src/lib/rate-limit", () => ({
    apiRateLimiter: {},
    checkRateLimit: vi.fn(async () => ({ success: true })),
    getRateLimitHeaders: vi.fn(() => ({})),
  }));

  vi.mock("@/src/lib/api-auth", () => ({
    verifyUserAuth: vi.fn(async () => ({ success: true, userId: "user-1" })),
  }));

  vi.mock("@/src/lib/telegram-auth", () => ({
    validateInitData: vi.fn(() => null),
  }));

  vi.mock("@/src/lib/supabase", () => ({
    createServerClient: () => ({
      from: (table: string) => ({
        update: (values: unknown) => {
          const rec = { table, values, filters: [] as string[] };
          h.calls.push(rec);
          const chain = {
            eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
            select: () => chain,
            single: async () => ({ data: { id: "user-1", ...(values as object) }, error: null }),
          };
          return chain;
        },
      }),
    }),
  }));

  import { PATCH } from "@/app/api/user/route";
  import { updateUserSchema } from "@/src/schemas/user";

  function patch(body: unknown) {
    return PATCH(
      new NextRequest("https://app.test/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  beforeEach(() => {
    h.calls = [];
  });

  // Reminders are gone (spec 2026-10-28) and nothing reads users.timezone any more, so the
  // app neither syncs nor stores it. Migration 029 drops the column.
  describe("updateUserSchema", () => {
    it.each(["en", "he", "ru"])("accepts language %s", (language) => {
      expect(updateUserSchema.safeParse({ language }).success).toBe(true);
    });

    it("requires a language", () => {
      expect(updateUserSchema.safeParse({}).success).toBe(false);
    });

    it("rejects a body that only carries a time zone", () => {
      expect(updateUserSchema.safeParse({ timezone: "Asia/Jerusalem" }).success).toBe(false);
    });

    it("strips a time zone sent next to the language", () => {
      expect(updateUserSchema.parse({ language: "ru", timezone: "Europe/Moscow" })).toStrictEqual({ language: "ru" });
    });
  });

  describe("PATCH /api/user", () => {
    it("writes only the language, even when an old app also sends a time zone", async () => {
      const res = await patch({ language: "he", timezone: "Asia/Jerusalem" });

      expect(res.status).toBe(200);
      expect(h.calls).toEqual([{ table: "users", values: { language: "he" }, filters: ["eq:id=user-1"] }]);
    });

    it("returns 400 and writes nothing for a time-zone-only body", async () => {
      const res = await patch({ timezone: "Asia/Jerusalem" });

      expect(res.status).toBe(400);
      expect(h.calls).toEqual([]);
    });
  });

  describe("TelegramProvider", () => {
    const src = readFileSync(resolve(process.cwd(), "components/TelegramProvider.tsx"), "utf8");

    it("never reads the device time zone or sends it to /api/user", () => {
      expect(src).not.toMatch(/resolvedOptions\(\)\.timeZone/);
      expect(src).not.toMatch(/timezone/i);
    });
  });
  ```
  What makes each test go red:
  - Keeping `timezone` in the schema fails `rejects a body that only carries a time zone` and `strips a time zone ...`.
  - Making `language` optional without the old refine fails `requires a language`.
  - Narrowing the enum fails `accepts language %s`.
  - Keeping `updates.timezone = ...` in the route, together with the old schema, fails `writes only the language ...`.
  - Accepting a timezone-only body fails `returns 400 ...`.
  - Leaving either sync block in TelegramProvider fails the provider test.

- [ ] **Step 2: Run the test and watch it fail**

  Run `npx vitest run __tests__/unit/user-update.test.ts`

  Expected: 5 of 9 fail.
  - `rejects a body that only carries a time zone`: success is `true`.
  - `strips a time zone sent next to the language`: the result still has `timezone: "Europe/Moscow"`.
  - `writes only the language ...`: values include `timezone: "Asia/Jerusalem"`.
  - `returns 400 ...`: the status is 200 and one update is recorded.
  - the TelegramProvider test: it matches `resolvedOptions().timeZone`.

  The 3 `accepts language` cases and `requires a language` already pass, because the old refine rejects `{}`.

- [ ] **Step 3: Rewrite `src/schemas/user.ts`**

  Replace the whole file content with:
  ```ts
  import { z } from "zod";

  export const updateUserSchema = z.object({
    language: z.enum(["en", "he", "ru"]),
  });
  ```

- [ ] **Step 4: Remove the timezone write from `app/api/user/route.ts`**

  In `PATCH`, delete this line (HEAD 119):
  ```ts
    if (parsed.data.timezone) updates.timezone = parsed.data.timezone;
  ```
  These lines stay: `const updates: Record<string, string> = {};` and `if (parsed.data.language) updates.language = parsed.data.language;`. GET, POST and the rest of PATCH are unchanged.

- [ ] **Step 5: Delete both time-zone sync blocks in `components/TelegramProvider.tsx`**

  a. In the web-app flow, delete the block from `            // Sync timezone if changed` to its `            } catch {}` (HEAD 235-245). Quote:
  ```tsx
              // Sync timezone if changed
              try {
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz && userData?.timezone !== tz) {
                  fetch("/api/user", {
                    method: "PATCH",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ timezone: tz }),
                  }).catch(() => {});
                }
              } catch {}
  ```
  The `if (userRes.ok) { ... }` body must then read:
  ```tsx
            if (userRes.ok) {
              const userData = await userRes.json();
              if (userData?.id) setUserId(userData.id);
              if (userData?.language) {
                const serverLocale = resolveLocale(userData.language);
                applyLocale(serverLocale);
              }
              if (userData?.first_name) {
                setUser({
                  id: userData.telegram_id,
                  first_name: userData.first_name,
                  last_name: userData.last_name,
                  username: userData.username,
                });
              }
            }
  ```

  b. In the Telegram registration flow, replace HEAD 331-356, from `          if (userRes.ok) {` and `            const userData2 = await userRes.json();` down to the `}` that closes `if (userRes.ok)` (just before `        } catch (e) {` / `console.error("[TelegramProvider] User registration error:", e);`). The new text:
  ```tsx
            if (userRes.ok) {
              const userData2 = await userRes.json();
              if (userData2?.id) setUserId(userData2.id);
              // Server-stored language is authoritative. Language is user-controlled via the
              // language sheet — never overwrite it from Telegram's language_code, since
              // unsupported codes (e.g. "en-US") would be normalized to "en" by resolveLocale
              // and clobber the user's explicit choice.
              if (userData2?.language) {
                const serverLocale = resolveLocale(userData2.language);
                applyLocale(serverLocale);
              }
            }
  ```
  The surrounding `try { ... } catch (e) { console.error("[TelegramProvider] User registration error:", e); }` stays. So do `jwtRef` (still used elsewhere in the file) and the deep-link, `setIsReady` and home-screen code. This also removes the two empty catches (`.catch(() => {})` and `catch {}`) from each block.

- [ ] **Step 6: Run the test and watch it pass**

  Run `npx vitest run __tests__/unit/user-update.test.ts`

  Expected: 9 passed.

- [ ] **Step 7: Run the gate**

  - `npx vitest run`: all green, 9 more tests than after T7 (one new file).
  - `npx tsc --noEmit`: no errors. If the Step 4 line were left in, `parsed.data.timezone` would now be a type error.
  - `npx eslint components/TelegramProvider.tsx src/schemas/user.ts app/api/user/route.ts __tests__/unit/user-update.test.ts`: no output, exit 0 (the three source files are lint-clean at HEAD).
  - Also run `grep -rn "timezone" src app components`: no matches. If any line remains, it means an earlier task missed a reader. Stop and report it, and don't widen this task.

- [ ] **Step 8: Commit**
  ```bash
  git add components/TelegramProvider.tsx src/schemas/user.ts app/api/user/route.ts __tests__/unit/user-update.test.ts
  git commit -F - <<'EOF'
  refactor: stop syncing and storing the device time zone

  Only reminders read users.timezone. The Mini App no longer sends the
  device time zone on startup (which also drops two empty catches), and
  PATCH /api/user now takes only a required language. A timezone sent by
  an old app is stripped, or rejected when it is the only field. The column
  is dropped in migration 029.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  EOF
  ```

BOUNDARY NOTE: Neither task makes tsc or the tests red at its boundary. One thing to know for T8: a Mini App still running the old cached code after the deploy will send `PATCH /api/user {timezone}`. That request now gets a 400, which the old code ignores (its `.catch` only catches network errors). Users notice nothing and nothing is written.

The inventory's critic suggested keeping the time zone until release 2. The spec and the task list remove it in release 1, and that is what these tasks do. This is safe because T2 (digest cron, bot snooze) and T4 (voice) have already removed every reader. The column itself stays until T11.

---

### Task 9: Remove the reminders strings from en, he and ru

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/he.json`
- Modify: `messages/ru.json`
- Create: `__tests__/unit/reminder-locale-keys.test.ts`

**Interfaces:**
- Consumes: T2's key `bot.remindersRemoved` (present in all three files); T2, T3, T5 and T6 having removed every code consumer of the keys below.
- Produces: nothing code-facing. The new test file pins what stays (nudge, grocery repeat, bot notice) and what goes.

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/reminder-locale-keys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

// The reminders feature is gone, so its strings must be gone from all three languages, and
// nothing in the code may still ask for one (next-intl would show the raw key path).
// The Remind/Ready nudge and the grocery repeat feature reuse "remind" and "recurring"
// wording, so the keys they own are pinned here as well.

const LOCALES = ["en", "he", "ru"];

type Json = { [key: string]: string | Json };

const load = (locale: string): Json =>
  JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), "utf8"));

function lookup(obj: Json, path: string): string | Json | undefined {
  let cur: string | Json | undefined = obj;
  for (const part of path.split(".")) {
    if (cur === undefined || typeof cur === "string" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const REMOVED_KEYS = [
  "lists.typeReminders",
  "items.addReminderPlaceholder",
  "items.overdue",
  "items.todayGroup",
  "items.tomorrowGroup",
  "items.thisWeekGroup",
  "items.laterGroup",
  "items.todayEvening",
  "items.tomorrowMorning",
  "items.custom",
  "items.tom",
  "settings.reminders",
  "settings.remindersDescription",
  "bot.itemReminder",
  "bot.itemReminderShared",
  "bot.openApp",
  "bot.digestMorning",
  "bot.digestEvening",
  "reminder", // the whole namespace
];

const KEPT_KEYS = [
  "items.reminderSent", // Remind button in a shared list
  "items.readySent",
  "items.signalError",
  "items.signalNoRecipients",
  "items.signal.remind",
  "items.signal.remindHint",
  "items.signal.ready",
  "items.signal.readyHint",
  "bot.listReminder",
  "bot.listReady",
  "bot.openList",
  "bot.remindersRemoved", // answer to a tap on an old reminder message
  "items.recurring.section", // grocery repeat staples
  "items.recurring.toggleOn",
  "items.recurring.toggleOff",
  "items.recurring.restore",
  "items.recurring.returnsInMinutes",
  "items.recurring.returnsInHours",
  "items.recurring.returningSoon",
  "lists.typeRegular",
  "lists.typeGrocery",
  "settings.listSettings",
];

describe("reminder locale keys", () => {
  for (const locale of LOCALES) {
    it(`messages/${locale}.json no longer has any reminders string`, () => {
      const messages = load(locale);
      const stillThere = REMOVED_KEYS.filter((k) => lookup(messages, k) !== undefined);
      expect(stillThere, `still in ${locale}.json: ${stillThere.join(", ")}`).toEqual([]);
    });

    it(`messages/${locale}.json keeps the nudge, repeat and bot-notice strings`, () => {
      const messages = load(locale);
      const gone = KEPT_KEYS.filter((k) => typeof lookup(messages, k) !== "string");
      expect(gone, `missing from ${locale}.json: ${gone.join(", ")}`).toEqual([]);
    });
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("translation keys used by the code", () => {
  // Every key the code names has to exist in en.json (locale-parity then guarantees he and
  // ru). Two shapes are read: a fully qualified string such as t("items.reminderSent"),
  // getMsg(lang, "bot.x") or sendSignal("remind", "items.reminderSent"), and a key relative to
  // the file's single useTranslations("ns") namespace. The removed top-level "reminder"
  // namespace is listed too, so a stale reference to it is still recognised as a key.
  it("every key named in app, components and src exists in en.json", () => {
    const en = load("en");
    const namespaces = [...new Set([...Object.keys(en), ...REMOVED_KEYS.map((k) => k.split(".")[0])])];
    const qualified = new RegExp(`["'](?:${namespaces.join("|")})\\.[A-Za-z0-9_.]+["']`, "g");
    const missing: string[] = [];

    for (const dir of ["app", "components", "src"]) {
      for (const file of sourceFiles(resolve(process.cwd(), dir))) {
        const source = readFileSync(file, "utf8");
        const where = file.replace(process.cwd() + "/", "");
        const check = (key: string) => {
          if (lookup(en, key) === undefined) missing.push(`${where}: ${key}`);
        };

        for (const m of source.matchAll(qualified)) check(m[0].slice(1, -1));

        const scoped = [...source.matchAll(/useTranslations\(\s*["']([\w.]+)["']\s*\)/g)].map((m) => m[1]);
        if (scoped.length === 1) {
          for (const m of source.matchAll(/(?<![\w.$])t\(\s*["']([\w.]+)["']/g)) check(`${scoped[0]}.${m[1]}`);
        }
      }
    }

    expect(missing, `keys with no entry in messages/en.json:\n${missing.join("\n")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run __tests__/unit/reminder-locale-keys.test.ts`
Expected: 3 failures, "messages/{en,he,ru}.json no longer has any reminders string" (message lists `lists.typeReminders, items.addReminderPlaceholder, ... reminder`). 4 pass: the three "keeps ..." tests (T2 already added `bot.remindersRemoved`) and the "every key named..." guard.

- [ ] **Step 3: Delete the keys from all three files with one script**

Run:

```bash
node - <<'JS'
const fs = require('fs');
const del = {
  lists: ['typeReminders'],
  items: ['addReminderPlaceholder', 'overdue', 'todayGroup', 'tomorrowGroup', 'thisWeekGroup', 'laterGroup', 'todayEvening', 'tomorrowMorning', 'custom', 'tom'],
  settings: ['reminders', 'remindersDescription'],
  bot: ['itemReminder', 'itemReminderShared', 'openApp', 'digestMorning', 'digestEvening'],
};
for (const l of ['en', 'he', 'ru']) {
  const p = `messages/${l}.json`;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [ns, keys] of Object.entries(del)) {
    for (const k of keys) {
      if (!(k in d[ns])) throw new Error(`${l}: ${ns}.${k} is not there`);
      delete d[ns][k];
    }
  }
  if (!('reminder' in d)) throw new Error(`${l}: reminder namespace is not there`);
  delete d.reminder;
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}
JS
```

Expected: no output. The script throws if a key is missing in any language. The files were already 2-space `JSON.stringify` output with a trailing newline, so no unrelated lines move.

- [ ] **Step 4: Check the diff is deletions only**

Run: `git diff --numstat messages/`
Expected: three rows, each with about 53 deleted lines. The exact count can differ by a line or two depending on where T2 put `bot.remindersRemoved`. Added lines are at most three per file.

Run: `git diff -U0 messages/ | grep -E '^\+[^+]'`
Expected: only lines that repeat a surviving key without its trailing comma, such as `"listSettings": "..."`, `"openList": "..."` or a closing `}`. No new text.

Run: `git diff messages/ | grep -E '^\+.*remindersRemoved'`
Expected: at most one line per file, `"remindersRemoved": "..."` repeated without its trailing comma because it became the last key in `bot`. Its text must be identical to the removed line. Any other `+` line with new text is a mistake.

- [ ] **Step 5: Run the test and locale parity**

Run: `npx vitest run __tests__/unit/reminder-locale-keys.test.ts __tests__/unit/locale-parity.test.ts`
Expected: 9 tests pass (7 + 2). If the "every key named..." test fails, a code path still names a deleted key. The message lists `file: key`. Fix it in the task that owns that file (T2 bot, T5 page and ItemRow, T6 handlers), not here.

- [ ] **Step 6: Check the guard catches a stale reference**

Run:

```bash
printf 'export const probe = "reminder.done";\n' > src/zz-probe.ts
npx vitest run __tests__/unit/reminder-locale-keys.test.ts 2>&1 | grep -E "zz-probe|Tests"
rm src/zz-probe.ts
```

Expected: the output names `src/zz-probe.ts: reminder.done` and reports 1 failed. Then `git status --short` shows no `src/zz-probe.ts`. Re-run the test file once more to confirm it is green again.

This guard turns red if any file reintroduces a deleted key, or if the `reminder` namespace is deleted while a `useTranslations("reminder")` call remains.

- [ ] **Step 7: Cross-check relative keys by hand**

Run: `git grep -nE "useTranslations\(['\"](reminder|reminders)['\"]\)" -- app components src`
Expected: no output.

Run: `git grep -nE "\bt\(['\"](overdue|todayGroup|tomorrowGroup|thisWeekGroup|laterGroup|tom|custom|todayEvening|tomorrowMorning|addReminderPlaceholder|typeReminders)['\"]" -- app components`
Expected: no output.

- [ ] **Step 8: Run the full gate**

Run: `npx vitest run`
Expected: all green, previous total + 7 tests (one new file).

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx eslint __tests__/unit/reminder-locale-keys.test.ts`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json __tests__/unit/reminder-locale-keys.test.ts
git commit -m "chore(i18n): remove the reminders strings from en, he and ru

Deletes the reminder namespace, the reminder list and row labels, the
digest and item-reminder bot messages and the unused settings keys. The
Remind/Ready nudge, grocery repeat and bot.remindersRemoved strings stay.
A new test pins both sides and checks that every translation key the code
names still exists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

BOUNDARY NOTE: the "every key named..." test (step 5) only goes green once T2, T3, T5 and T6 have removed every consumer of the deleted keys. It fails on `app/list/[id]/page.tsx` (`lists.typeReminders`, `items.overdue`, `items.*Group`), `app/page.tsx` (`lists.typeReminders`), `components/AddItemInput.tsx` (`items.addReminderPlaceholder`), `components/ItemRow.tsx` (relative `tom`) and `src/hooks/useItemHandlers.ts` (`reminder.sent`, `reminder.cancelled`), or on `src/services/bot.ts` (`reminder.*`, `bot.itemReminder*`, `bot.digest*`, `bot.openApp`) if those are not fully removed. `items.reminderSent` is passed as a string to `sendSignal`; the test covers it and the key stays. T2 must have added `bot.remindersRemoved` in all three languages, or the three "keeps ..." tests fail.

---

### Task 10: Remove the diagnostic scripts, fix the README, run the leftover audit

**Files:**
- Delete: `scripts/audit-reminder-list-binding.mjs`
- Delete: `scripts/diagnose-reminder-dupes.mjs`
- Delete: `scripts/cleanup-lehem-duplicate.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: T1-T9 complete on the branch; T8 (no `timezone` left in `app`, `components`, `src`).
- Produces: none. `scripts/migrate.mjs` stays untouched.

- [ ] **Step 1: Run the leftover audit and watch it find the scripts**

Run (set the pattern first, it is reused in steps 5-7):

```bash
PAT='item_reminders|remind_at|my_remind|my_reminder|ReminderSheet|TimePicker|react-wheel-picker|time-picker|bell-pulse|complete-recurring|process-reminders|reminder-digest|cron/(reminders|digest)|CRON_SECRET|sendItemReminder|sendReminderDigest|reminderAt|onReminderTap|isOverdue|isReminders|groupByDate|ReminderItemsList|shouldSearchWhileTyping|reminder-suppression|services/recurring|schemas/reminders|typeReminders|addReminderPlaceholder|digestMorning|digestEvening|itemReminder|reminders_enabled|remindersUrl|pickPreferredReminder|handleSetReminder|handleUpdateReminder|handleDeleteReminder|handleCancelReminder|reminderItem|pendingReminderText|diagnose-reminder|audit-reminder|cleanup-lehem|\brecurrence\b|[Ss]nooze'
git grep -nE "$PAT" -- app components src lib messages scripts README.md package.json | grep -vE '^src/services/bot\.ts:[0-9]+:\s*(//|\*|/\*)'
```

Expected now: hits only in the three scripts (the `audit-reminder-list-binding`, `diagnose-reminder-dupes` and `cleanup-lehem` file contents) and in `README.md` (`remind_at`, `CRON_SECRET`, and so on). Hits anywhere else mean an earlier task is incomplete (see BOUNDARY NOTE).

- [ ] **Step 2: Delete the three scripts**

```bash
git rm scripts/audit-reminder-list-binding.mjs scripts/diagnose-reminder-dupes.mjs scripts/cleanup-lehem-duplicate.mjs
```

Expected: three `rm 'scripts/...'` lines. `ls scripts` then shows only `migrate.mjs`. `package.json` references none of them (verified at HEAD).

- [ ] **Step 3: Edit the README prose**

Make these edits with exact replacements in `README.md` (line numbers are HEAD hints).

Line 17, replace

`against the right list — including reminders and recurring items. The interesting part`

with

`against the right list. The interesting part`

Line 24, replace

`on the correct list, with reminders and recurrence pulled from natural speech.`

with

`on the correct list.`

Line 28, replace the whole bullet

`- **Reminders, recurrence, and daily digests** — set per-item reminders, mark items as recurring, and receive scheduled reminder/digest messages in Telegram.`

with

`- **Recurring grocery staples** — mark a grocery item as recurring and it returns to the list four hours after you check it off.`

Line 36, replace

`{ text, action, targetList, remind_at, recurrence }`

with

`{ text, action, targetList }`

and replace

`removes soft-delete the best active match, and any \`remind_at\` becomes a reminder row. The user gets`

with

`removes soft-delete the best active match. The user gets`

Line 44, replace the whole paragraph that starts with `**Scheduled work and a build-time migration runner.**` and ends with `under \`docs/\`.` with:

`**Scheduled cleanup and a build-time migration runner.** A daily Supabase \`pg_cron\` job purges soft-deleted items, lists and stale pending collaborator requests. The database schema is a series of numbered SQL migrations applied by a small custom runner (\`scripts/migrate.mjs\`) that tracks applied files in a \`_migrations\` table and is wired into the \`build\` step so deploys stay in sync. The project is spec-driven: each feature has a design spec and implementation plan under \`docs/\`.`

The count is dropped on purpose: "23" was already stale (27 migrations at HEAD, 28 after T1), and a number goes stale on every migration.

Line 52, replace

`Supabase \`pg_cron\` + \`pg_net\` + Vault for scheduled reminders/digests`

with

`Supabase \`pg_cron\` for the daily soft-delete cleanup`

Line 86, delete the whole table row

`| \`CRON_SECRET\` | Bearer secret authorizing scheduled cron calls (provided by the host in production) |`

Line 120, replace

`and scheduled reminders and daily digests run inside Supabase through \`pg_cron\` + \`pg_net\` calling the app's authenticated cron routes.`

with

`and a daily Supabase \`pg_cron\` job purges soft-deleted rows.`

Line 30 (the "remind to update" hand-off bullet) and lines 97 and 104 (the migration runner in the build) stay as they are.

- [ ] **Step 4: Check the README**

Run: `grep -nEi "remind|digest|cron|pg_net|vault|recurr|migrations" README.md`
Expected: exactly these hits and nothing else:
- line 30 keeps "remind to update" (the Remind/Ready nudge); the voice bullet (line 24) stays but no longer matches;
- lines 97 and 104, which describe the migration runner in the build;
- the recurring bullet (line 28);
- the `pg_cron` cleanup sentence in the "Scheduled cleanup" paragraph;
- the `pg_cron` entry in the Infra bullet;
- the `pg_cron` sentence in Deployment;
- "numbered SQL migrations" in the paragraph above.

No `remind_at`, `CRON_SECRET`, `pg_net`, `Vault` or "23".

- [ ] **Step 5: Final leftover audit, feature identifiers**

Run:

```bash
git grep -nE "$PAT" -- app components src lib messages scripts README.md package.json | grep -vE '^src/services/bot\.ts:[0-9]+:\s*(//|\*|/\*)'
git grep -n "ncdai" -- package.json package-lock.json
comm -13 <(git diff --name-only --diff-filter=AM main...HEAD -- __tests__ | sort) <(git grep -lE "$PAT" -- __tests__ | sort)
```

Expected: no output from any of the three.

The allow-list is exactly: old migrations 014-027, migrations 028 and 029, anything under `docs/superpowers/`, comment lines in `src/services/bot.ts` (the T2 catch-all), and test files added or modified on this branch. A hit inside a branch test (for example a stale `remindAt` input in the executor-factory test, or a `remind_at` field in the voice test) must be read and must be a negative assertion or a stale-input fixture. Any hit in an untouched test file is a leftover to delete.

- [ ] **Step 6: Final leftover audit, list type, time zone, bot buttons, files**

Run:

```bash
git grep -nE "[\"']reminders[\"']" -- app components src lib scripts
git grep -niE "timezone" -- app components src lib scripts
git grep -n "reminder_" -- app components src lib messages
git ls-files | grep -iE 'reminder|digest|snooze|time-?picker|wheel' | grep -vE '^supabase/migrations/0(1[4-9]|2[0-9])_|^docs/superpowers/' | grep -vxFf <(git diff --name-only --diff-filter=A main...HEAD)
```

Expected:
- First command: no output.
- Second command: no output.
- Third command: only lines in `src/services/bot.ts` (the T2 catch-all: the `startsWith("reminder_")` branch and its comments). No other file.
- Fourth command: no output. Migrations 014-029 and docs are filtered; files added on this branch (the migration tests, `reminder-locale-keys.test.ts`, the bot catch-all test) are subtracted.

- [ ] **Step 7: Final leftover audit, the surviving "remind" wording**

Run:

```bash
git grep -nEi "remind" -- app components src lib messages scripts | grep -vE 'sendListReminder|listReminder|handleRemind|onRemind|reminderToast|ReminderToast|remindersRemoved|reminderSent|"remind"|"remindHint"|list-remind|\[Remind\]|// Send reminders|Reminder toast|send list reminder' | grep -viE '^src/services/bot\.ts:.*(reminder_|removed|old reminder)'
```

Expected: no output. What stays is the Remind/Ready nudge (`app/api/lists/[id]/remind/route.ts`, `SignalSheet`, `ToastContainer`, `handleRemind`, `setReminderToast`, `items.reminderSent`, `items.signal.*`, `bot.listReminder`) and the T2 catch-all lines in `bot.ts`. A hit outside that list is a leftover.

- [ ] **Step 8: Run the full gate**

Run: `npx vitest run`
Expected: all green; test count unchanged from the end of Task 9 (no test file touched).

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx eslint scripts/migrate.mjs`
Expected: no output.

Run: `npx eslint .`
Expected: exactly one problem, the pre-existing `set-state-in-effect` error in `app/login/callback/page.tsx` (about line 108). The list page's old `duplicateTexts` warning and `set-state-in-effect` error were inside code T5 deleted. Any other finding is a reminders leftover and must be fixed in the task that owns the file.

Run: `npx next build` (never `npm run build`, which runs `scripts/migrate.mjs` against production first)
Expected: the build completes. The `ENVIRONMENT_FALLBACK` error printed during static generation is pre-existing and harmless.

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: remove the reminders text from the README and delete the reminder scripts

Drops the three one-off reminder diagnostic scripts and rewrites the
README: no reminders, digests, remind_at or CRON_SECRET, the recurring
bullet now describes grocery staples, and the migration count is no
longer hardcoded.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

(The `git rm` from step 2 is already staged, so the commit includes the deletions.)

BOUNDARY NOTE: the step 6 time-zone check expects T8 to be complete; until it is, `timezone` still appears in `components/TelegramProvider.tsx`, `src/schemas/user.ts` and `app/api/user/route.ts`. The step 6 `reminder_` check expects T2's catch-all to be written with `startsWith("reminder_")` and to be the only user of that prefix. Also, the inventory critic said to keep the TelegramProvider time-zone sync until the table-drop release, which conflicts with this task order; I followed the task order (T8 deletes it).

---

### Task 11: Migration 029 drops the reminder data and retires the reminders list type (release 2)

**Files:**
- Create: `supabase/migrations/029_drop_reminders_data.sql`
- Create: `__tests__/unit/migration-029-drop-reminders-data.test.ts`

**Interfaces:**
- Consumes: T1's migration 028 (already run in production by release 1). Consumes T2–T10 having removed every code read of `item_reminders` and `users.timezone` from `app/`, `src/`, `components/` and `scripts/`. This task's guard test asserts it.
- Produces: migration file `029_drop_reminders_data.sql`. When it has run, `lists` has the constraint `lists_type_check CHECK (type IN ('regular','grocery'))`, the table `item_reminders` no longer exists, and `users.timezone` no longer exists.

- [ ] **Step 1: Write the failing test.** Create `__tests__/unit/migration-029-drop-reminders-data.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

// Migration 029 is release 2 of the reminders sunset
// (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md). It runs on production before
// `next build`, can run twice (scripts/migrate.mjs records it in a separate step), and drops
// data, so the order of its statements and its preconditions matter.
const raw = readFileSync(
  resolve(process.cwd(), "supabase/migrations/029_drop_reminders_data.sql"),
  "utf8"
);
// Comments may quote the forms forbidden below, so check only the SQL that runs.
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

const SOFT_DELETE =
  /UPDATE\s+lists\s+SET\s+deleted_at\s*=\s*now\(\)\s+WHERE\s+type\s*=\s*'reminders'\s+AND\s+deleted_at\s+IS\s+NULL\s*;/i;
const RETYPE = /UPDATE\s+lists\s+SET\s+type\s*=\s*'regular'\s+WHERE\s+type\s*=\s*'reminders'\s*;/i;

describe("migration 029_drop_reminders_data", () => {
  it("soft-deletes straggler reminders lists before retyping them", () => {
    const softDelete = sql.search(SOFT_DELETE);
    const retype = sql.search(RETYPE);
    expect(softDelete).toBeGreaterThanOrEqual(0);
    expect(retype, "retyping first would turn live stragglers into visible regular lists").toBeGreaterThan(
      softDelete
    );
  });

  it("adds the lists.type CHECK only when missing, after the retype", () => {
    const retype = sql.search(RETYPE);
    const guard = sql.search(
      /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'lists_type_check'/i
    );
    const add = sql.search(
      /ALTER\s+TABLE\s+lists\s+ADD\s+CONSTRAINT\s+lists_type_check\s+CHECK\s*\(\s*type\s+IN\s*\(\s*'regular'\s*,\s*'grocery'\s*\)\s*\)\s*;/i
    );
    const endIf = sql.search(/END\s+IF\s*;/i);
    expect(retype).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(retype);
    expect(add).toBeGreaterThan(guard);
    expect(endIf).toBeGreaterThan(add);
  });

  it("drops the reminders table and the time zone column, idempotently and without CASCADE", () => {
    expect(sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+item_reminders\s*;/i);
    expect(sql).toMatch(/ALTER\s+TABLE\s+users\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+timezone\s*;/i);
    expect(sql, "an unexpected dependent must fail the deploy, not vanish silently").not.toMatch(/\bCASCADE\b/i);
  });

  it("never calls cron.unschedule by job name and leaves cleanup-soft-deletes alone", () => {
    expect(sql).not.toMatch(/cron\.unschedule\s*\(\s*'/i);
    expect(sql).not.toContain("cleanup-soft-deletes");
  });

  it("has no transaction control of its own", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|END)\s*;/im);
    expect(sql).not.toMatch(/\bSTART\s+TRANSACTION\b/i);
  });
});

// Dropping a table or column that live code still reads breaks production at runtime with no
// type error, so release 2 is safe only while nothing reads them.
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(full)) acc.push(full);
  }
  return acc;
}

describe("release 2 precondition", () => {
  it("no app code or script reads item_reminders or users.timezone", () => {
    const root = process.cwd();
    const patterns = [
      /\.from\(\s*["'`]item_reminders["'`]\s*\)/,
      /\.select\(\s*["'`][^"'`]*\btimezone\b[^"'`]*["'`]/,
      /\.timezone\b/,
    ];
    const offenders: string[] = [];
    for (const dir of ["app", "src", "components", "scripts"].map((d) => resolve(root, d))) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        if (patterns.some((p) => p.test(text))) offenders.push(file.replace(root + "/", ""));
      }
    }
    expect(
      offenders,
      `these files still read data that migration 029 drops: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
```

What turns each test red: (1) putting the `type = 'regular'` UPDATE before the soft-delete, or removing the soft-delete; (2) removing the `pg_constraint` guard, adding the constraint before the retype, or widening the CHECK; (3) removing either drop, removing `IF EXISTS`, or adding `CASCADE`; (4) adding `cron.unschedule('…')` or touching `cleanup-soft-deletes`; (5) wrapping the file in `BEGIN;`/`COMMIT;`; (6) bringing back any read such as `.from("item_reminders")` in a route or script, `.select("id, language, timezone")` in `src/services/voice-handler.ts`, or `userData?.timezone` in `components/TelegramProvider.tsx`.

- [ ] **Step 2: Run the test and confirm it fails.** Run `npx vitest run __tests__/unit/migration-029-drop-reminders-data.test.ts`. Expected: the file fails before any test runs, with `ENOENT: no such file or directory, open '.../supabase/migrations/029_drop_reminders_data.sql'`.

- [ ] **Step 3: Write the migration.** Create `supabase/migrations/029_drop_reminders_data.sql`:

```sql
-- Sunset reminders, release 2 (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md).
-- Push only after release 1 (migration 028 plus the code removal) is live in production: the code
-- from before release 1 reads item_reminders and users.timezone, and release 1's code reads
-- neither. Safe to re-run: no BEGIN/COMMIT, and each statement does nothing the second time.

-- 1. Catch stragglers: a reminders list that an old app created during release 1's deploy window.
UPDATE lists SET deleted_at = now() WHERE type = 'reminders' AND deleted_at IS NULL;

-- 2. Retire the type. Every reminders list is soft-deleted by now. Making them regular lets the
--    CHECK hold for every row until cleanup-soft-deletes purges them.
UPDATE lists SET type = 'regular' WHERE type = 'reminders';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lists_type_check' AND conrelid = 'public.lists'::regclass
  ) THEN
    ALTER TABLE lists ADD CONSTRAINT lists_type_check CHECK (type IN ('regular', 'grocery'));
  END IF;
END $$;

-- 3. Delete the reminder data. No CASCADE: nothing depends on either of them (migrations 014-026
--    add no view, trigger, function or publication entry for them), and an unexpected dependent
--    should fail the deploy loudly instead of being dropped along with them.
DROP TABLE IF EXISTS item_reminders;
ALTER TABLE users DROP COLUMN IF EXISTS timezone;
```

- [ ] **Step 4: Run the test and confirm it passes.** Run `npx vitest run __tests__/unit/migration-029-drop-reminders-data.test.ts`. Expected: 6 passed. If "release 2 precondition" fails, the message names the files T2–T10 left behind. Stop and report them; don't fix them in this task.

- [ ] **Step 5: Prove the tests bite.** In the SQL file, temporarily move the line `UPDATE lists SET type = 'regular' WHERE type = 'reminders';` above the soft-delete UPDATE. Run `npx vitest run __tests__/unit/migration-029-drop-reminders-data.test.ts`. Expected: 1 failed ("soft-deletes straggler reminders lists before retyping them"). Put it back. Next, temporarily change `DROP TABLE IF EXISTS item_reminders;` to `DROP TABLE IF EXISTS item_reminders CASCADE;` and run again. Expected: 1 failed (the drops test). Put it back. Finally, temporarily add the line `// probe: user.timezone` to the end of `src/lib/list-icons.ts` and run again. Expected: 1 failed ("no app code or script reads…", offender `src/lib/list-icons.ts`). Remove the line and confirm `git diff --stat src/lib/list-icons.ts` shows nothing. Run again. Expected: 6 passed.

- [ ] **Step 6: Run the gate.** Run `npx vitest run`. Expected: all green, with 6 more tests than at the end of T10. Run `npx tsc --noEmit`. Expected: no errors. Run `npx eslint __tests__/unit/migration-029-drop-reminders-data.test.ts`. Expected: no problems.

- [ ] **Step 7: Commit as its own last commit, and don't push it with release 1.** Release 1 is everything up to T10. It goes to production first. This commit is pushed only after GitHub reports a successful production deploy for release 1's commit.

```bash
git add supabase/migrations/029_drop_reminders_data.sql __tests__/unit/migration-029-drop-reminders-data.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 029 drops reminder data and retires the reminders type

Release 2 of the reminders sunset. Soft-deletes any reminders list an old
app created during release 1's deploy, retypes all reminders rows to
regular, adds lists_type_check (regular, grocery) only when missing, and
drops item_reminders and users.timezone. Idempotent, no BEGIN/COMMIT, no
CASCADE. A guard test fails if any code or script still reads the dropped
table or column.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

BOUNDARY NOTE: T1 and T11 stay inside their boundaries, and both end with green tests, tsc and eslint. Two things depend on other tasks. (a) T11's "release 2 precondition" test passes only if T2–T10 removed every `.from("item_reminders")`, every `.select(...timezone...)` and every `.timezone` read in `app/`, `src/`, `components/` and `scripts/`. At HEAD 685eb83 those are in the two cron routes, the reminder routes, `bot.ts`, `recurring.ts`, `voice-handler.ts`, `api/user/route.ts`, `TelegramProvider.tsx` and the three scripts. If any survive, this test goes red at T11 on purpose, and the fix belongs to the task that missed it. (b) For "Migration 029: same unschedule check", the spec's testing section says only that much, so I read it as "029 contains no by-name `cron.unschedule`". 029 itself unschedules nothing, as the T11 boundary lists. Optionally, before release 2 is pushed, the controller can run a read-only `SELECT type, count(*) FROM lists GROUP BY type` to confirm no third type would make `ADD CONSTRAINT` fail.

---

### Finish: review, merge, release 1, release 2, cleanup

- [ ] **Step 1: Whole-branch review.** An independent reviewer on the strongest model reviews `git diff main...sunset-reminders` against the spec and this plan. Fix every valid finding in the task's files, re-run the gate, and commit.
- [ ] **Step 2: Final gate on the branch tip.** Run `npx vitest run`, `npx tsc --noEmit`, `npx eslint .` (expected: only the login-callback error) and `npx next build`.
- [ ] **Step 3: Merge locally.** Run `git checkout main && git merge --ff-only sunset-reminders`. `main` now contains T1-T11. T11 is the last commit.
- [ ] **Step 4: Push release 1 without T11.** Run `git push origin <T10-sha>:main`, where `<T10-sha>` is `git rev-parse HEAD~1` after checking that `HEAD` is the T11 commit (`git log -1 --format=%s` starts with `feat(db): migration 029`).
- [ ] **Step 5: Wait for release 1 to be live.** Poll the GitHub status of `<T10-sha>` (`gh api repos/{owner}/{repo}/commits/<T10-sha>/status` or `/check-runs`) until Vercel's production deployment reports success. If it fails, read the build log, fix forward, and do not push T11.
- [ ] **Step 6: Verify release 1 in production (read-only).**
  - **Cron jobs:** `SELECT jobname, active FROM cron.job` must list only `cleanup-soft-deletes`.
  - **Lists:** `SELECT count(*) FROM lists WHERE type = 'reminders' AND deleted_at IS NULL` must be 0.
  - **If the jobs are still there** (hidden by row-level security), stop and tell the owner. Do not write to production.
- [ ] **Step 7: Push release 2.** Run `git push origin main`, which pushes the T11 commit. Wait for its deployment to succeed. Then check read-only that `to_regclass('public.item_reminders')` is null, that `users` has no `timezone` column, and that `lists_type_check` exists.
- [ ] **Step 8: Cleanup commit.**
  - **Delete:** `git rm docs/superpowers/notes/2026-10-15-reminders-deprecation.md docs/superpowers/plans/2026-10-28-sunset-reminders.md`.
  - **Keep the spec,** and mark its status as shipped.
  - **Commit and push** to `main`.
- [ ] **Step 9: Update memory.**
  - **Remove:** the parked reminders entry and the "off in reminders lists" detail in the search-while-typing note.
  - **Record:** that reminders were removed on 2026-10-28.
- [ ] **Step 10: Ping the owner** with a push notification once release 2 is verified.
