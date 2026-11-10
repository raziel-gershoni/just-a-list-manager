# Dependency upgrades

**Date:** 2026-11-10
**Status:** owner approved the recommendations (2026-11-10): "go with your recommendations, I'll test
everything in the end".

## Why

- **Next.js 16.1.6** has critical advisories. The RSC denial-of-service pair (GHSA-q4gf, GHSA-8h8q)
  plausibly reaches this app, and the image-optimizer RCEs are fixed only in 16.4. 16.4 is the active
  line; 16.1 has had no release since 2026-03-16.
- **zod 4.3.6** has a high memory-exhaustion advisory that API request bodies can reach.
- **The Telegram bot library 0.66** drags in the deprecated `request` chain, which carries 4 critical
  advisories. None of them is reachable, so that part is cleanup.
- Everything else is staying current, done in small steps while the jumps are still small.

Every bump below was first trial-installed in an isolated worktree and passed the full gate. A second
agent then tried to refute each finding against the real changelogs and the code (evaluation run
`wf_c4345904-36b`).

## Decisions

1. **Supabase JS stays on 2.95.3.** A plain bump silently breaks live sync: from 2.112.1, rejoins
   send the publishable key instead of the app's JWT, so RLS hides every realtime event. The bump
   gains nothing reachable. The way to do it later is parked in
   `docs/superpowers/notes/2026-11-10-supabase-js-upgrade.md`.
2. **Icons: accept lucide 1.x's redrawn glyphs.** 32 of the 78 icons the app uses change shape,
   including list icons users picked (Apple, Heart, ShoppingCart). The 0.x line is frozen.
3. **Gemini: move to the v1 endpoint**, which is the SDK 3 default. The rollback is the env var
   `GOOGLE_GENAI_API_VERSION=v1beta`.
4. **Remove the unused shadcn leftovers:** `radix-ui`, `class-variance-authority`, `clsx`,
   `tailwind-merge` and `lib/utils.ts`. `shadcn` itself stays, because `app/globals.css` imports
   `shadcn/tailwind.css`.

### Small calls (mine, approved with the rest)

- **Pin Node 24 for Vercel.** `package.json` gets `"engines": { "node": "24.x" }`. Vercel lets this
  field override the dashboard setting, so nobody has to check the dashboard. 24 is a maintained LTS.
  It also avoids Node 26's fetch change (HTTP/2) on calls to Telegram, Gemini and Supabase.
  `@types/node` follows (^24). Nanoid 6, genai 3 and the tooling need Node 22 or newer.
- **zod:** `createItemSchema.items` gets `.max(500)`. The zod fix only protects arrays that declare a
  cap, and the route already allows at most 500 items.
- **Next:** `agentRules: false` in `next.config.ts`, so `next dev` run by a coding agent doesn't
  write an `AGENTS.md` to the repo root. The option must exist in 16.4.6; it is verified, not guessed.
- **The bot's "Open App" label** moves into the i18n strings: one key used by the four buttons in
  `src/services/bot.ts`. After the bump, `/start` really sets the chat menu button with it.
- **Telegram error redaction** (`src/lib/telegram-errors.ts`, which enforces the "no tokens in logs" rule): it
  is dropped only if a test that drives the real 1.x library proves the bot token never appears in
  an error. That test stays as the guard, and it must fail when a token is injected.

## Batches (one commit each, in this order; all pushed together)

| # | Change | Risk |
|---|---|---|
| 1 | Remove the unused `supabase` CLI and `@testing-library/react` | none at runtime |
| 2 | Remove the unused shadcn leftovers (decision 4) | none at runtime |
| 3 | `next` + `eslint-config-next` 16.4.6 and `react` + `react-dom` 19.3.1 (all exact), `@types/react(-dom)` lockfile update, the new react-hooks lint findings, `agentRules: false` | medium |
| 4 | `next-intl` ^4.14.10 | low |
| 5 | Node 24 pin, `@types/node` ^24 | low |
| 6 | Dev tooling: `typescript` ^6.0.3, `vitest` ^4.1.12, `eslint` ^10.14.0 (fallback ^9.39.5 if 10 can't pass) | none at runtime |
| 7 | `zod` ^4.6.7 with the `.max(500)`, `jose` ^6.2.17, `nanoid` ^6.0.2 | low |
| 8 | `@upstash/ratelimit` ^2.2.0, `@upstash/redis` ^1.41.0 | low-medium |
| 9 | `@google/genai` ^3.0.0 | medium |
| 10 | `node-telegram-bot-api` ^1.2.0, `@types/node-telegram-bot-api` removed, the redaction rule, the "Open App" label | low |
| 11 | `tailwindcss` + `@tailwindcss/postcss` ^4.3.5, `shadcn` ^4.23.0 | low |
| 12 | `lucide-react` ^1.71.0 | medium (visual) |
| 13 | `@dnd-kit/react` 0.5.3 and `@dnd-kit/dom` 0.5.3 (exact), type rename | medium (iOS) |
| 14 | `npm audit fix` sweep (lockfile only, no `--force`) | low |

Every batch passes the full gate before its commit, and commits the exact lockfile the gate ran on.

## Holds

| Package | Stays at | Why | What unblocks it |
|---|---|---|---|
| typescript 7 | 6.0.3 | 7.0 ships no JS compiler API: typescript-eslint and `no-silent-catches.test.ts` break. | typescript-eslint support for TS 7.1 |
| node-telegram-bot-api 2.x | 1.2.0 | A full redesign: a 12-file port, a `getMe` call per cold start, automatic sendMessage retries (duplicate risk), no `getFileLink`, breaking changes in minor releases. | 1.x going unmaintained |
| postgres 4 | 3.4.8 | A 12-day-old rewrite that runs inside every prod deploy (`scripts/migrate.mjs`). 3.4.9 only changes types. | Some months of 4.x maturity |
| @supabase/supabase-js | 2.95.3 | Decision 1. | A two-device prod test session |
| vitest 5 | 4.1.12 | 8 days old, and it flips `clearMocks` on by default. | 5.x settling |
| date-fns 5 | 4.4.0 | Only an alpha exists. | A stable 5.0 |

## What tests can't see (the owner's end-of-run checklist)

1. **Deploy:** the Vercel build log shows Node 24, `Next.js 16.4.6` and `[Migrate] Up to date`, with
   no supabase CLI download.
2. **Navigation:** go Home → a list → back, a few times quickly. Scroll position restores, no
   keyboard pops up, no flicker.
3. **Adding and editing:** add several items in a row (the keyboard stays up), edit inline, and type
   in the categories sheet.
4. **Phone unlock:** lock the phone for a minute or more with a list open, unlock and tap at once. The
   tap registers, and a second device's change appears.
5. **Login and invites:** web login, and accepting an invite from a second account.
6. **Languages:** switch en → he → ru. Hebrew is RTL from the first paint. Spot-check plurals.
7. **Login token:** cold-open the app, reopen it after days away, and open a share link from a second
   account.
8. **Rate limiting:** a duplicate voice note is processed once, and a grocery categorize runs.
9. **Voice:** a Hebrew voice note with an amount, e.g. "תוסיף שני ליטר חלב וביצים". The logs show
   `[VoiceProcessor] usage` with finishReason STOP. A 400 or 404 means v1 refused the request; roll
   back with the env var.
10. **Bot:** `/start`, where the menu button now reads "Open App" in the user's language. Also
    `/start invite_…`, `/help` in all three languages, approving and declining a join request,
    Remind, List ready and a voice message.
11. **Looks:** light and dark mode, and the toast and offline-indicator animations, also in RTL.
12. **Icons:** look over the icon picker, create a list and change its icon and colour, and check
    that VoiceOver/TalkBack still announce icon-only buttons.
13. **Drag, iOS first:**
    - Long-press drag a list card and a grocery item. Nothing snaps at pickup, and the order persists.
    - A tap after a drop doesn't open the list.
    - Swipe-minimise the app mid-drag.
    - A fast swipe scrolls instead of dragging.
    - Drag an item across grocery categories.
    - Auto-scroll works at the edges, also in Hebrew.
    - The categories sheet grip works.
    - Drag with the keyboard up.
    - On Android, a second finger is ignored.
