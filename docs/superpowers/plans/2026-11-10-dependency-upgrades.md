# Dependency upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app's dependencies to the versions the 2026-11-10 evaluation recommended, one
batch per commit, with the gate green after each.

**Architecture:** Each task bumps one group of packages with exact versions and makes only the code
changes that group needs. Every task's changes were trial-run during the evaluation; its reference
diff and gate log are named in the task brief. Nothing is pushed until the whole plan is done.

**Tech Stack:** npm 11, Next.js 16, React 19, Vitest, ESLint flat config, TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-10-dependency-upgrades-design.md`

## Global Constraints

- **Gate before every commit:**
  `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit && npx next build`.
- **Never run `npm run build`:** it runs `scripts/migrate.mjs` against the production DB. Never run
  `npm audit fix --force`. Never read or print `.env*`.
- **Installs:** install with `npm install <pkg>@<exact version>` (or `--save-exact` where the spec
  says exact). Commit `package.json` and `package-lock.json` exactly as the gate ran on them.
- **One commit per batch** (two where a task says so). Commit messages end with the session's
  `Co-Authored-By` and `Claude-Session` lines.
- **No live calls** to Gemini, Telegram, Supabase or Upstash. Tests mock them.
- **Strings:** no inline user-facing strings. en/he/ru change in the same commit. Hebrew and Russian
  read as natively written.
- **Guards:** a new guard counts only after its test has been seen failing with the guard removed.
- **Audit:** record `npm audit --omit=dev` totals before and after each task in its report.

## Review Focus

1. **Lockfile drift:** a later `npm install` re-resolves an earlier batch's package to a different
   version. Each task checks that `npm ls` still shows the earlier batches' versions.
2. **Duplicate copies:** two copies of `@dnd-kit/dom`, `react`, `zod` or `typescript` in the tree
   after a bump. Each task runs `npm ls <pkg>` for its own packages.
3. **"Use client" icons in server code:** lucide 1.x icons are `"use client"` modules, and
   `src/lib/list-icons.ts` is imported by API route schemas. Task 10 proves this works at runtime or
   splits the names out.
4. **Token leaks:** the bot token must never reach logs after the Telegram library swap. Task 8's
   test drives the real library and fails when a token is injected.
5. **Lint-suppression creep:** Task 2 adds only the disables the evaluation listed, each with its
   reason. Nothing is refactored at runtime.

---

### Task 1: Remove unused packages (2 commits)

**Files:** `package.json`, `package-lock.json`, `README.md`, `lib/utils.ts` (delete),
`__tests__/unit/no-silent-catches.test.ts`

- [ ] **Step 1:** `grep -rn` confirms nothing imports `@testing-library`, `radix-ui`,
  `class-variance-authority`, `clsx`, `tailwind-merge` or `@/lib/utils` (outside `lib/utils.ts`
  itself and `components.json`), and nothing invokes the `supabase` CLI (scripts, package.json,
  docs). Record the evidence in the report.
- [ ] **Step 2:** `npm uninstall supabase @testing-library/react`. In README, line ~55 "Vitest,
  Testing Library" becomes "Vitest", and line ~109 drops "with Testing Library". Gate.
  Commit: `chore(deps): remove the unused Supabase CLI and Testing Library`.
- [ ] **Step 3:** `npm uninstall radix-ui class-variance-authority clsx tailwind-merge`, delete
  `lib/utils.ts` (and `lib/` if empty), and remove `"lib/utils.ts"` from the file list in
  `no-silent-catches.test.ts` (~line 197). Keep `components.json`, `shadcn` and the
  `@import "shadcn/tailwind.css"`. Gate.
  Commit: `chore(deps): remove unused shadcn leftovers`.

### Task 2: Next 16.4.6 and React 19.3.1

**Files:** `package.json`, `package-lock.json`, `next.config.ts`, `app/(app)/page.tsx`,
`components/TelegramProvider.tsx`, `src/hooks/useReconnectOrchestrator.ts`,
`app/login/callback/page.tsx`, `app/(app)/invite/[token]/page.tsx`

- [ ] **Step 1:** `npm install --save-exact next@16.4.6 eslint-config-next@16.4.6 react@19.3.1
  react-dom@19.3.1`, then `npm update @types/react @types/react-dom` (lockfile only; the `^19` ranges
  stay). Check `npm ls react next eslint-plugin-react-hooks typescript-eslint`.
- [ ] **Step 2:** Run eslint and confirm the new findings match the evaluation: 14 errors and 2
  warnings, from react-hooks 7.1 and one `@next/next` rule.
- [ ] **Step 3:** Apply the lint fixes from the reference diff:
  - In `app/(app)/page.tsx`, move the view-switch effect below the `toast` useState. Effect order
    is unchanged.
  - Add the justified `eslint-disable-next-line` comments (5 in page.tsx, 2 in TelegramProvider,
    2 in useReconnectOrchestrator, 1 in login callback).
  - Reword the TelegramProvider ~222 comment: it copies a ref during render.
  - Remove the now-unused directive in the invite page.
  - No runtime refactors.
- [ ] **Step 4:** Check the Next 16.4.6 docs and types (`node_modules/next/dist/server/config-shared.d.ts`)
  for the option that stops `next dev` from writing `AGENTS.md` (expected: `agentRules`). Set it to
  `false` in `next.config.ts`. If no such option exists in 16.4.6, don't add anything; report it.
- [ ] **Step 5:** Gate, with build output showing `Next.js 16.4.6`.
  Commit: `chore(deps): Next 16.4.6 and React 19.3.1`.

### Task 3: next-intl 4.14.10

- [ ] `npm install next-intl@4.14.10` (caret range in package.json), gate.
  Commit: `chore(deps): next-intl 4.14.10`.

### Task 4: Node 24 and the dev toolchain (2 commits)

**Files:** `package.json`, `package-lock.json`, `README.md`, new `__tests__/helpers/mock-fn.ts`, about
20 test files, `__tests__/unit/mutation-queue.test.ts`, `__tests__/unit/voice-handler-failures.test.ts`

- [ ] **Step 1:** Add `"engines": { "node": "24.x" }` to package.json and `npm install
  @types/node@^24` (latest 24.x). README "Node.js 20+" becomes "Node.js 24". Gate.
  Commit: `chore(deps): pin Node 24 for Vercel; @types/node 24`.
- [ ] **Step 2:** `npm install typescript@^6.0.3 vitest@^4.1.12 eslint@^10.14.0`. Then apply the
  test-only fixes from the reference diff:
  - New `__tests__/helpers/mock-fn.ts` exporting `type AnyMock = Mock<(...args: any[]) => any>`,
    with one justified no-explicit-any disable.
  - Replace the 36 uses of `ReturnType<typeof vi.fn>` in about 20 test files with `AnyMock`.
  - Add `afterEach(() => vi.restoreAllMocks())` in `mutation-queue.test.ts`.
  - Type the `(a: unknown[])` parameter at `voice-handler-failures.test.ts:144`.
  - Only if tsc reports TS2882 on `./globals.css`, add a `declare module "*.css" {}` shim.

  If ESLint 10 can't pass the gate with eslint-config-next 16.4.6, use `eslint@^9.39.5` and say why
  in the report. Gate.
  Commit: `chore(deps): TypeScript 6, Vitest 4, ESLint 10`.

### Task 5: zod, jose, nanoid

**Files:** `package.json`, `package-lock.json`, `src/schemas/items.ts`, a schema test

- [ ] **Step 1:** Write a failing test: `createItemSchema` rejects 501 items and accepts 500. See it
  fail.
- [ ] **Step 2:** `npm install zod@^4.6.7 jose@^6.2.17 nanoid@^6.0.2`. Add `.max(500)` to
  `createItemSchema.items`. See the test pass. Bite check: remove `.max(500)` and see it red.
- [ ] **Step 3:** Confirm the JWT tests still pass unchanged (sign/verify, clock tolerance, wrong
  secret, `alg: none`). Gate.
  Commit: `chore(deps): zod 4.6, jose 6.2, nanoid 6; cap items per add at 500`.

### Task 6: Upstash

- [ ] `npm install @upstash/ratelimit@^2.2.0 @upstash/redis@^1.41.0`, gate.
  Commit: `chore(deps): Upstash ratelimit 2.2 and redis 1.41`.

### Task 7: Gemini SDK 3

**Files:** `package.json`, `package-lock.json`, `src/services/voice-processor.ts`,
`src/services/categorizer.ts`, the two `*-sdk.test.ts` files

- [ ] **Step 1:** In both SDK tests, add an assertion that the request URL contains `/v1/models/`
  (not `/v1beta/`). It fails on 2.27. See it fail.
- [ ] **Step 2:** `npm install @google/genai@^3.0.0`. See the tests pass. Refresh the stale
  "@google/genai 2.27" comments (`voice-processor.ts` ~30, `categorizer.ts` ~45). The model id
  stays `gemini-3.8-flash`. Gate.
  Commit: `chore(deps): @google/genai 3 (v1 endpoint)`.

### Task 8: Telegram bot library 1.2.0 (2 commits)

**Files:** `package.json`, `package-lock.json`, `src/services/bot.ts`, `app/api/webhook/route.ts`,
`src/lib/telegram-errors.ts` (maybe delete), its callers,
`__tests__/unit/telegram-error-redaction.test.ts`, `__tests__/unit/join-request-bot.test.ts`,
`__tests__/unit/removed-reminder-buttons.test.ts`, `messages/{en,he,ru}.json` or the bot's string
source

- [ ] **Step 1:** `npm install node-telegram-bot-api@^1.2.0` and `npm uninstall
  @types/node-telegram-bot-api`. Switch the `TelegramBot.*` namespace types to named type imports
  (`Message`, `CallbackQuery`, `Update`, …) in the 4 files.
- [ ] **Step 2:** Rewrite `telegram-error-redaction.test.ts` so it drives the real 1.x library
  through an injected `request.fetch`, covering a 4xx answer, a 429, and a network failure. It
  asserts that no `bot<token>` substring appears in the error's message, its stack, or
  `util.inspect(error)`. Bite: make the fake fetch put the token into the error and see it red.
- [ ] **Step 3:** If, and only if, Step 2's test proves the library never puts the token into an
  error, delete `src/lib/telegram-errors.ts` and its call sites. Otherwise keep it and say why.
  Every catch still logs its error.
- [ ] **Step 4:** Gate. Commit: `chore(deps): node-telegram-bot-api 1.2 (drops the request chain)`.
- [ ] **Step 5:** Put the "Open App" label (4 places in `src/services/bot.ts`) into the bot's i18n
  strings, as one key used everywhere, through `getMsg(lang, …)` with the user's language.
  - en "Open App", he "פתיחת האפליקציה", ru "Открыть приложение". Adjust only if the existing
    bot copy uses a different established phrasing.
  - Add a test that the menu button and inline buttons use the key per language.
  - Gate. Commit: `fix(bot): the Open App label follows the user's language`.

### Task 9: Tailwind 4.3 and shadcn 4

- [ ] `npm install tailwindcss@^4.3.5 @tailwindcss/postcss@^4.3.5 shadcn@^4.23.0` (both Tailwind
  packages on the same version). Gate. Compare the built CSS before and after
  (`.next/static/css`). Expect only equivalent value changes; report anything else.
  Commit: `chore(deps): Tailwind 4.3 and shadcn 4`.

### Task 10: lucide-react 1.71

**Files:** `package.json`, `package-lock.json`, maybe `src/lib/list-icons.ts` and a new names module

- [ ] **Step 1:** `npm install lucide-react@^1.71.0`. Confirm every imported icon name still
  exists. Gate.
- [ ] **Step 2:** Prove what happens when an API route imports `src/lib/list-icons.ts` (via
  `src/schemas/lists.ts`) now that icons are `"use client"` modules. Check the built route bundle,
  or run `next start` with placeholder public env and call a route whose validation uses the icon
  enum: a bad icon gets 400, a good one passes validation.
  - If that can't be proven offline, move the icon **names** into a server-safe module that the
    schemas import.
  - The icons map keeps its components, and a test asserts the names equal the map's keys. Bite it.
- [ ] **Step 3:** Gate. Commit: `chore(deps): lucide-react 1.71`.

### Task 11: dnd-kit 0.5.3 (2 commits)

**Files:** `components/list/CategoriesSheet.tsx`, `src/hooks/useListDragDrop.ts`,
`src/hooks/useListsDragDrop.ts`, `package.json`, `package-lock.json`, maybe
`components/SortableItem.tsx` and `components/SortableListCard.tsx`

- [ ] **Step 1:** Rename `DragDropEvents` to `DragDropEventHandlers["onDragStart" | "onDragEnd"]` in
  the 3 files (this compiles on 0.2.4). Gate.
  Commit: `refactor(dnd): event handler types that compile on dnd-kit 0.2 and 0.5`.
- [ ] **Step 2:** `npm install @dnd-kit/react@0.5.3` and `npm install --save-exact
  @dnd-kit/dom@0.5.3` together. `npm ls @dnd-kit/dom` must show one copy. Refresh the 0.2.4 comment
  in `useListsDragDrop.ts` (~40-44). Keep the window-level pointercancel backstop.
- [ ] **Step 3:** Read the 0.5.3 Feedback plugin source for how it handles the element's computed
  `transition`. Reproduce what it does with Tailwind's
  `transition-transform duration-150` value (a node script on the real string).
  - If it mangles the value, move `transition-transform duration-150` and the `isDragSource`
    scale/shadow classes from the ref element onto an inner div in `SortableItem.tsx` and
    `SortableListCard.tsx`. Same look; the ref element then carries no transition.
  - Report the evidence either way.
- [ ] **Step 4:** Gate. Commit: `chore(deps): dnd-kit 0.5.3`.

### Task 12: Final lockfile sweep

- [ ] `npm audit fix` (no `--force`). Confirm package.json is unchanged and no direct dependency
  moved off its batch version (`npm ls --depth=0`). Gate. Record the remaining `npm audit` and
  `npm audit --omit=dev` advisories, each with its dependency path.
  Commit: `chore(deps): lockfile audit sweep`.
