# Sync Engine Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A change the user makes is never lost, reordered or silently undone; the screen shows the user's latest intent until the server confirms it; navigation, reloads and network blips never break the session.

**Architecture:**
- **Session:** one `TelegramProvider` per app launch, in a route-group layout, with honest token results and a reconnect that does only what is needed.
- **Engine:** a module-level sync engine (`src/sync/engine.ts`) replaces the per-hook queue. It runs every change through `executor-factory`, in per-item chains with list-wide barriers, and keeps a persisted temp→real id map.
- **Merge:** refresh and realtime overlay each item's pending fields instead of overwriting them.
- **Server:** recycle becomes idempotent, bulk routes act only on the ids sent, and the server keeps the tap time.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase Realtime (realtime-js 2.95), next-intl, Vitest 3 (node env), zod 4.

**Spec:** `docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md` (approved 2026-10-29). Audit evidence: `scratchpad/sync/audit.json`. Fixed interfaces and repo rules: `scratchpad/sync/shared-context.md` (binding for every task).

## Global Constraints

- **Logging:** never log tokens, JWTs, initData, raw bodies, item text or list names. `__tests__/unit/no-silent-catches.test.ts` stays green.
- **Queue contract:**
  - 4xx other than 401/408/429: dropped, with the items.syncError toast and a list refresh.
  - 401: kept, and the engine asks for a token refresh.
  - Offline, 5xx, 408 and 429: kept for retry.
  - Expiry and evictions: reported, never silent.
- **Error messages:** "<Verb> failed: <status>", and verbs never contain "fetch" or "network".
- **Strings:** none new. Reuse items.syncError, errors.generic, errors.notFound, lists.loadError, common.retry, common.goHome.
- **Settled decisions stay:** Clear completed / Unmark all are not queued (call 4A, revert plus toast on failure); an unticked received item keeps its truck mark.
- **Owner decisions 1-4 in the spec are binding:** typed adds recycle, last write wins, bulk actions scoped to shown ids, home counts match the list.
- **Migrations:** applied on deploy, never by hand. Never run `npm run build` (it migrates prod).
- **Tests:** nothing reaches a live service, and each new check is removed once to confirm its test goes red.
- **Commit trailers:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y`.

## Review Focus

1. **Reopen with a saved queue.** The list must show the replayed changes, never the pre-change state (ruling R3; the test lives in Task 3b).
2. **A 401 arriving mid-reconnect or while initializing.** Sync must resume after the token refresh, never park silently (ruling R15; the test lives in Task 3c).
3. **A request that never settles, or a user who keeps tapping during a reconnect.** The reconnect must still finish (ruling R16; the test lives in Task 3a).
4. **A pending restore-recurring or "on the way" during a refresh or echo.** The item must not jump (ruling R2; the test lives in Task 4a).
5. **Clear completed or Unmark all inside one round trip of a tick.** Documented limitation under call 4A; the final review reads the flow.

## Controller rulings (amend the task sections; they win over the task text)

- **R1, interface extensions:** accepted.
  - `flushAllQueues(getJwt, executorFactory, onAuthNeeded?)` and `useMutationQueue(..., onMutationSuccess?, onAuthNeeded?)`.
  - `resetSyncEngines()` is for tests only.
  - The chain key for "recycle" is `payload.recycleId`.
  - `unskip-all` maps to `skipped_at` for every id in `payload.itemIds`.
- **R2, wider field map in T3's engine:**
  - `order` → `ordered_at`, `skipped_at`.
  - `restore-recurring` → `recurring`, `completed`, `completed_at`, `skipped_at`, `ordered_at`, `position`.
  - T4 adds a test: a refresh, and a realtime echo, during a pending restore-recurring and a pending order leave the item where the user put it.
- **R3, the mount load waits for the replay (T3b):**
  - Once a JWT exists, the list page runs `await flushQueue()`, then `fetchItems()`, instead of two independent effects.
  - Changes still kept after that flush (offline) appear when they land. That is a documented limitation.
  - Test: open a page with a persisted toggle; the first GET goes out after the replay settled, and the row shows the toggled state.
- **R4, expiry and eviction with no page open (T3a):** the engine keeps unreported drops in memory and delivers them to `onError` on the next `attach()` of that list, so the user sees the toast when they open it. They are logged either way.
- **R5, the Home refresh reports failure (T5b):** the refresh Home registers for the orchestrator rejects on failure, so the banner doesn't claim success. It still keeps the lists on screen and never shows the full-page error.
- **R6:** a temp item cleared or unmarked before its create lands is left as today (rare; pre-existing). Note it in the report.
- **R7:** a catch-up refresh may overlap an orchestrator refresh. Both go through the merge, so it is harmless.
- **R8, typecheck (T5c):** T5c adds the five new required `useListRealtime` params to every caller, including `__tests__/unit/list-merge-flows.test.ts`. They are not made optional.
- **R9, typed-add matching (T5a):** `findCompletedExactMatch` searches all completed items on screen for an exact normalized match, with no top-10 limit. The server no longer limits recycle to its top ten.
- **R10, error view (T5c):** the list error view keeps T1d's `<OfflineIndicator />`. The final JSX is T1d's fragment with the new Go home button. A 403/404 shows only `errors.notFound` + Go home.
- **R11, realtime CLOSED is final** (verified in realtime-js 2.95: `_onClose` sets state closed and removes the channel; errors set errored and rejoin on the same channel).
  - T1: on a CLOSED it didn't cause itself, the hook removes that channel and asks for a debounced reconnect, so the list gets a new channel.
  - T4: the catch-up refresh fires on (a) SUBSCRIBED after CHANNEL_ERROR or TIMED_OUT on the same channel, and (b) the first SUBSCRIBED of a channel that replaced a failed or closed one.
  - T4's "CLOSED then SUBSCRIBED on the same channel" test is replaced by case (b).
- **R12:** at launch, initData is sent whatever its age, so the server's clock decides. Later fallbacks follow the 5-minute device-clock rule. Accepted.
- **R13, a bad `at` (T2c):** an `at` that doesn't parse is ignored and the server uses now, never a 400. Use `z.string().optional()` plus a NaN guard in the tap-time helper.
- **R14, deploy skew:** the bulk routes require `itemIds`, with no legacy no-body path. A pre-deploy bundle gets a revert and a toast until it reloads, which is honest and loses no data.
- **R15, a 401 never parks sync silently (T3a + T1b):**
  - A 401 keeps the entry and still schedules the engine's normal backoff retry.
  - `requestTokenRefresh` called during a running reconnect sets a flag, and one more token refresh runs when that reconnect ends. It is never dropped.
- **R16, `flush()` resolves (T3a):** it resolves when every entry queued at its start has settled once. Changes added during the flush don't extend it, so a stream of taps can't hold the reconnect.
- **R17:** barriers wait behind parked failures, per the spec, with T3's backoff. Accepted.
- **R18, `pendingFields` reads memory (T3a):** an in-memory index of queued and in-flight entries is updated on add, settle and dequeue. It never re-reads or parses localStorage per call.
- **R19:** every caller of a rejecting `refreshItems` handles the rejection; the T4 reviewer checks with grep. T4 adds a test that the page's registered refresh rejection reaches the orchestrator as a failed step.
- **R20:** POST /api/user only while initData is fresh. Accepted.
- **R21:** recycle requires the same text; an edited row inserts new. Accepted.
- **R22, auto-unskip and auto-respawn go through the engine (T3b):** the direct PATCHes in `fetchItems` become engine changes: `skip` with `skipped: false`, and `restore-recurring`. That keeps them ordered with the user's own changes.
- **R23, T1 snapshot:** where a task anchors on "T1's sandbox draft", the implementer uses T1's committed code. If a name differs, it uses the committed equivalent and says so in its report. Conditional steps resolve as follows:
  - T3 creates `src/utils/coalesce.ts` if it needs it; T4 reuses it.
  - T4 adds the localStorage stub only if a test needs it.
  - T5 passes whatever params the committed hooks require.

## Final steps (controller, after the last task)

1. Whole-branch review on Opus across lenses (engine correctness, session and auth, merge, server, UI), each finding adversarially verified. Fix every valid finding, then a scoped re-review.
2. Gate: `npx next typegen && npx vitest run && npx tsc --noEmit && npx eslint && npx next build`. Never `npm run build`.
3. Push to main, check the Vercel deploy and the migration, then ping the owner.
4. Hand the owner the manual prod checks:
   - Mini App: bot "Open list" buttons, an invite link (start_param), Telegram "Reload page", Home → list → Home after 5+ minutes.
   - Web: login, logout, OAuth callback.
5. Update memory:
   - The executor-factory GOTCHA becomes "one path: the engine plus executor-factory; a missing case drops with a toast, guarded by single-executor.test.ts".
   - Add a sync-engine note.
   - Update README's offline-sync paragraph.
   - Delete this plan file in a follow-up commit.

---

### Task 1: Session: one provider per launch, honest token handling, reconnect does only what is needed

T1 runs first, so no earlier task has touched these files. Every snippet below is anchored on today's source (commit `2934605`). The four sub-tasks run in order, and each one ends green and commits.

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H1 | `src/hooks/useJWTRefresh.ts:24-37` returns `null` for every failure: a network throw, a 429, a 5xx and a 401 all look the same. `src/hooks/useReconnectOrchestrator.ts:93-110` then calls `clearJwt()` on any failure, falls back to the launch initData (refused after 5 min, `src/lib/telegram-auth.ts:50-57`), and in web mode removes `web_auth_token`. `:116-121` goes to `/login` after 5 tries. `components/TelegramProvider.tsx:204-210` does the same in the web bootstrap. `useReconnectOrchestrator.ts:93` refreshes on every reconnect, and `:141` recreates the client every time | `fetchToken` returns `TokenResult`: only a 401 is `unauthorized`. `ensureToken` keeps the token on `transient`, refreshes only past 24 h (or when forced), clears only on `unauthorized`, and falls back to initData only while it is fresh. `syncRealtime` calls `setAuth` on a live socket and recreates the client only when the socket is down. `requestTokenRefresh` serves 401s from API calls | `telegram-provider-bootstrap.test.ts` › "a failed token refresh keeps the session (H1)" and "a reconnect does only what is needed (H1)". `jwt-refresh-logging.test.ts` › "useJWTRefresh tells a refusal from a failure that may pass" |
| H2 | `app/page.tsx:916-921`, `app/list/[id]/page.tsx:431-437` and `app/invite/[token]/page.tsx:169-175` each mount their own `<TelegramProvider>`, so every navigation starts a new session. `useJWTRefresh.ts:6-7` keeps the Mini App JWT in memory only. `TelegramProvider.tsx:314-345` always signs in, and POSTs `/api/user`, with the launch initData | Route group `app/(app)/layout.tsx` owns the provider, and the pages move under it. The Mini App JWT lives in `sessionStorage` `tg_auth_token`. A reload seeds it (same Telegram user only) and takes the bearer path. The user record loads with the bearer once initData is stale | `one-session-provider.test.ts`. `telegram-provider-bootstrap.test.ts` › "a Telegram reload keeps the session (H2)". `jwt-refresh-logging.test.ts` › "useJWTRefresh stores the token where the next load finds it (H2)" |
| H10 | `TelegramProvider.tsx:314-356`: with no token, the bootstrap still sets `isReady=true` and the state `idle` (shown as "connected"), and nothing retries. `src/hooks/useListData.ts:52-53` and `app/page.tsx:121-122` return on no JWT without clearing `loading`. The skeletons (`app/list/[id]/page.tsx:168-180`, `app/page.tsx:468-479`) render no `OfflineIndicator`. `useReconnectOrchestrator.ts:197-215`: `reconnect()` runs during `initializing`. `TelegramProvider.tsx:255,356` force `idle` | `startSession`: a transient launch failure counts as the first attempt and hands over to the retry (`scheduleRetry`). `isReady` = bootstrapped and (JWT, or `auth_failed`, or retries spent). `reconnect()` returns while `initializing`. With no JWT, `fetchItems`/`fetchLists` show the error screen. The skeleton and error screens render `OfflineIndicator` | `telegram-provider-bootstrap.test.ts` › "a failed sign-in at launch hands over to the retry (H10)". `list-page-session.test.ts`. `home-fetch-lists.test.ts` › "home without a session (H10)" |
| H23 | `src/hooks/useRealtimeList.ts:102-176`: both `resubscribe()` and the `[supabaseClient]` effect create a channel, and `resubscribedRef` is set only on `SUBSCRIBED`. `:181-190`: cleanup removes only `channelRef`. `TelegramProvider.tsx` has no unmount cleanup, and its heartbeat keeps calling `runReconnect` | `useRealtimeList.subscribe(client)` is the only place a channel is created. It reuses the channel on the same client, and `resubscribe` resolves at once while joined. Cleanup removes only its own client's channel. The provider disconnects on unmount, and an `unmountedRef` mutes the heartbeat and `syncRealtime` | `realtime-cleanup.test.ts` › "useRealtimeList keeps one channel per list (H23)". `telegram-provider-bootstrap.test.ts` › "the provider cleans up its socket (H23)" |

---

### Task 1a: One TelegramProvider for every signed-in screen (route group)

**Files:**
- Move (`git mv`): `app/page.tsx` → `app/(app)/page.tsx`; `app/list/[id]/page.tsx` → `app/(app)/list/[id]/page.tsx`; `app/list/[id]/error.tsx` → `app/(app)/list/[id]/error.tsx`; `app/invite/[token]/page.tsx` → `app/(app)/invite/[token]/page.tsx`
- Create: `app/(app)/layout.tsx`
- Modify: `app/(app)/page.tsx`, `app/(app)/list/[id]/page.tsx`, `app/(app)/invite/[token]/page.tsx` (each drops its own provider wrapper)
- Test (create): `__tests__/unit/one-session-provider.test.ts`
- Test (modify, path and harness only): `__tests__/unit/categories-sheet-wiring.test.ts`, `__tests__/unit/category-realtime-wiring.test.ts`, `__tests__/unit/reminders-ui-removed.test.ts`, `__tests__/unit/restore-skipped-wiring.test.ts`, `__tests__/unit/list-type-switch.test.ts`, `__tests__/unit/grouped-list-wiring.test.ts`, `__tests__/unit/home-fetch-lists.test.ts`, `__tests__/unit/home-background-saves.test.ts`, `__tests__/unit/search-completed-items.test.ts`

**Interfaces:**
- Consumes: `TelegramProvider` (default export of `components/TelegramProvider.tsx`, unchanged here).
- Produces: `app/(app)/layout.tsx` `export default function AppLayout({ children }: { children: React.ReactNode })`, which renders `<TelegramProvider>{children}</TelegramProvider>`. The pages' default exports are now the screen components themselves: `HomePage`, `ListPage`, `InvitePage`. URLs are unchanged. `/login` and `/login/callback` stay in `app/login`.

- [ ] **Step 1: Write the failing guard test.** Create `__tests__/unit/one-session-provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { ReactElement, ReactNode } from "react";

// A page that mounts its own provider starts a new session on every navigation, with the
// launch initData that the server refuses after 5 minutes (H2). One layout owns it instead.
vi.mock("@/components/TelegramProvider", () => ({ default: function TelegramProvider() { return null; } }));

import AppLayout from "@/app/(app)/layout";
import TelegramProvider from "@/components/TelegramProvider";

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

describe("one TelegramProvider per app launch", () => {
  it("the (app) layout wraps its screens in the provider", () => {
    const child = "screen" as ReactNode;
    const el = AppLayout({ children: child }) as ReactElement<{ children: ReactNode }>;
    expect(el.type).toBe(TelegramProvider);
    expect(el.props.children).toBe(child);
  });

  it("home, list and invite live under the layout, and the login pages stay outside it", () => {
    for (const f of ["app/(app)/page.tsx", "app/(app)/list/[id]/page.tsx", "app/(app)/invite/[token]/page.tsx", "app/login/page.tsx", "app/login/callback/page.tsx"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
    for (const f of ["app/page.tsx", "app/list/[id]/page.tsx", "app/invite/[token]/page.tsx"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(false);
    }
  });

  it("nothing but the (app) layout renders a TelegramProvider", () => {
    const renderers = ["app", "components", "src"]
      .flatMap(walk)
      .filter((f) => /<TelegramProvider[\s>]/.test(readFileSync(join(ROOT, f), "utf8")))
      .map((f) => relative(".", f));
    expect(renderers).toEqual([join("app", "(app)", "layout.tsx")]);
  });
});
```

- [ ] **Step 2: Run it, expect a failure.**
  Run: `npx vitest run __tests__/unit/one-session-provider.test.ts`
  Expected: FAIL. The file cannot import `@/app/(app)/layout` (it does not exist yet).

- [ ] **Step 3: Move the pages into the route group.**

```bash
mkdir -p "app/(app)/list/[id]" "app/(app)/invite/[token]"
git mv app/page.tsx "app/(app)/page.tsx"
git mv "app/list/[id]/page.tsx" "app/(app)/list/[id]/page.tsx"
git mv "app/list/[id]/error.tsx" "app/(app)/list/[id]/error.tsx"
git mv "app/invite/[token]/page.tsx" "app/(app)/invite/[token]/page.tsx"
```

  Afterwards `app/list` and `app/invite` are empty. git does not track empty folders, so remove them: `rmdir "app/list/[id]" app/list "app/invite/[token]" app/invite`.

- [ ] **Step 4: Create `app/(app)/layout.tsx`:**

```tsx
import TelegramProvider from "@/components/TelegramProvider";

// One TelegramProvider for every signed-in screen, so the session (JWT, user, realtime
// client) survives moving between them. /login and /login/callback stay outside the group:
// they must never run the Telegram bootstrap or its web-mode redirect to /login.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <TelegramProvider>{children}</TelegramProvider>;
}
```

- [ ] **Step 5: Unwrap the three pages.** The provider now comes from the layout.

  `app/(app)/page.tsx`. Replace:

```tsx
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";
```
  with:
```tsx
import { useTelegram } from "@/components/TelegramProvider";
```
  Replace `function HomeContent() {` (line 43) with `export default function HomePage() {`. Delete the wrapper at the end of the file:
```tsx

export default function HomePage() {
  return (
    <TelegramProvider>
      <HomeContent />
    </TelegramProvider>
  );
}
```

  `app/(app)/list/[id]/page.tsx`. Replace the same `import TelegramProvider, { useTelegram } ...` line with `import { useTelegram } from "@/components/TelegramProvider";`. Replace `function ListContent() {` (line 34) with `export default function ListPage() {`. Delete:
```tsx

export default function ListPage() {
  return (
    <TelegramProvider>
      <ListContent />
    </TelegramProvider>
  );
}
```

  `app/(app)/invite/[token]/page.tsx`. Replace the same import line with `import { useTelegram } from "@/components/TelegramProvider";`. Replace `function InviteContent() {` (line 10) with `export default function InvitePage() {`. Delete:
```tsx

export default function InvitePage() {
  return (
    <TelegramProvider>
      <InviteContent />
    </TelegramProvider>
  );
}
```

- [ ] **Step 6: Point the existing tests at the moved files.** Their assertions are unchanged.

```bash
sed -i '' 's#"app/list/\[id\]/page.tsx"#"app/(app)/list/[id]/page.tsx"#g; s#"@/app/list/\[id\]/page"#"@/app/(app)/list/[id]/page"#g; s#read("app/page.tsx")#read("app/(app)/page.tsx")#g; s#"@/app/page"#"@/app/(app)/page"#g; s#// A sheet defined in app/page.tsx#// A sheet defined in app/(app)/page.tsx#' __tests__/unit/categories-sheet-wiring.test.ts __tests__/unit/category-realtime-wiring.test.ts __tests__/unit/reminders-ui-removed.test.ts __tests__/unit/restore-skipped-wiring.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/home-background-saves.test.ts __tests__/unit/search-completed-items.test.ts
```

  Three harnesses unwrapped the page from its provider. They now call the page directly:

  `__tests__/unit/home-background-saves.test.ts`. Replace:
```ts
// The page's own component: HomePage wraps it in the (stubbed) TelegramProvider.
const HomeContent = ((HomePage() as El).props.children as El).type as () => El;
```
  with:
```ts
// The page component itself: the provider lives in app/(app)/layout.tsx.
const HomeContent = HomePage as () => El;
```

  `__tests__/unit/home-fetch-lists.test.ts`. Replace:
```ts
const HomeContent = (HomePage() as El).props.children as El;
const Content = HomeContent.type as () => El;
```
  with:
```ts
// The page component itself: the provider lives in app/(app)/layout.tsx.
const Content = HomePage as () => El;
```

  `__tests__/unit/list-type-switch.test.ts`. Replace:
```ts
// The page's own component: ListPage wraps it in the (stubbed) TelegramProvider.
const ListContent = ((ListPage() as El).props.children as El).type as () => El;
```
  with:
```ts
// The page component itself: the provider lives in app/(app)/layout.tsx.
const ListContent = ListPage as () => El;
```

  Check: `grep -rn '"app/list\|"app/page\|"app/invite\|@/app/page\|@/app/list' __tests__` prints nothing.

- [ ] **Step 7: Regenerate Next's route types, then run the gate.** `.next/types/validator.ts` is gitignored and still imports `../../app/page.js` and the other old paths, so `tsc` would fail on stale generated files. Regenerate them first. `typegen` writes only `.next/types` and runs no build or migration.

```bash
npx next typegen
npx vitest run __tests__/unit/one-session-provider.test.ts
npx vitest run
npx tsc --noEmit
npx eslint "app/(app)" __tests__/unit/one-session-provider.test.ts __tests__/unit/home-background-saves.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/list-type-switch.test.ts
```
  Expected: the guard passes (3 tests), the full suite is green, and tsc and eslint print nothing.

- [ ] **Step 8: Make it bite.**
  - In `app/(app)/layout.tsx` return `<>{children}</>`. "the (app) layout wraps its screens in the provider" and "nothing but the (app) layout renders a TelegramProvider" go red. Restore.
  - Re-add a wrapper to a page: append `export function Wrapped() { return <TelegramProvider><InvitePage /></TelegramProvider>; }` plus `import TelegramProvider from "@/components/TelegramProvider";` to `app/(app)/invite/[token]/page.tsx`. "nothing but the (app) layout renders a TelegramProvider" goes red. Restore.

- [ ] **Step 9: Commit.**

```bash
git add "app/(app)/layout.tsx" "app/(app)/page.tsx" "app/(app)/list/[id]/page.tsx" "app/(app)/list/[id]/error.tsx" "app/(app)/invite/[token]/page.tsx" __tests__/unit/one-session-provider.test.ts __tests__/unit/categories-sheet-wiring.test.ts __tests__/unit/category-realtime-wiring.test.ts __tests__/unit/reminders-ui-removed.test.ts __tests__/unit/restore-skipped-wiring.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/home-fetch-lists.test.ts __tests__/unit/home-background-saves.test.ts __tests__/unit/search-completed-items.test.ts
git commit -m "$(cat <<'EOF'
refactor(app): one TelegramProvider for every signed-in screen

Home, list and invite each mounted their own provider, so every navigation
started a new session with the launch initData, which the server refuses
after 5 minutes (H2). A route-group layout app/(app)/layout.tsx now owns the
one provider; the pages move under it and URLs stay the same. /login and its
callback stay outside, so they never run the Telegram bootstrap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```
  (`git mv` already staged the moves. The `git add` of the new paths stages the edits made after the move.)

---

### Task 1b: Honest token handling, a session that survives a reload, a launch failure that retries

**Files:**
- Modify (whole file): `src/hooks/useJWTRefresh.ts`
- Modify (whole file): `src/hooks/useReconnectOrchestrator.ts`
- Modify: `components/TelegramProvider.tsx`
- Test (rewrite): `__tests__/unit/telegram-provider-bootstrap.test.ts`. Its harness stubbed `useJWTRefresh` and the orchestrator and ran only the bootstrap effect. It now runs the real provider and both real hooks. Its three old tests (refused registration, refused web user load, old client's channel cleanup) are kept under the same names, moved to the new flow. The web user load now runs after the bootstrap check, and its log line is `User load failed:` (it was `Web user load failed:`). The client is now replaced by a `"timeout"` heartbeat (it was a direct `recreateSupabaseClient` call).
- Test (rewrite): `__tests__/unit/jwt-refresh-logging.test.ts`. The four old tests are kept with the new return shape (`{ kind }` instead of `null`/string). New tests cover the transient/unauthorized split, storage, and the age helpers.

**Interfaces:**
- Consumes: `createBrowserClient(token, onHeartbeat)` from `src/lib/supabase.ts` (unchanged); `removeAllChannelsLogged` from `src/lib/realtime-cleanup.ts` (unchanged); realtime-js 2.95.3 `client.realtime.isConnected(): boolean`, `client.realtime.setAuth(token): Promise<void>`.
- Produces (`src/hooks/useJWTRefresh.ts`):
  - `export type TokenResult = { kind: "ok"; token: string } | { kind: "unauthorized" } | { kind: "transient" };`
  - `export function useJWTRefresh(isWebAppRef: React.RefObject<boolean>): { jwt: string | null; jwtRef: React.RefObject<string | null>; fetchToken: (initData: string | null) => Promise<TokenResult>; setToken: (token: string) => void; clearJwt: () => void }`. Only a 401 is `unauthorized`. A network throw, a 408, a 429, a 5xx and an unreadable answer are `transient`. With neither a JWT nor initData it returns `unauthorized` without a request. `setToken` and an ok `fetchToken` store the token (web: `localStorage` `web_auth_token`; Mini App: `sessionStorage` `tg_auth_token`); `clearJwt` removes it.
  - `export function isInitDataFresh(initData: string, now?: number): boolean`
  - `export function readTokenClaims(token: string): { iat?: number; telegram_user_id?: number } | null`
  - `export function tokenAgeMs(token: string, now?: number): number`
  - `export function readStoredToken(isWebApp: boolean): string | null`
- Produces (`src/hooks/useReconnectOrchestrator.ts`):
  - `export const MAX_RETRIES = 5;`
  - The params take `syncRealtime: (token: string) => void` instead of `recreateSupabaseClient`, and `fetchToken` returns `Promise<TokenResult>`.
  - Returns `{ connectionStatus, retryCount, reconnect, runReconnectRef, startSession: () => Promise<void>, requestTokenRefresh: () => void }`. `setOrchestratorState` is no longer returned.
- Produces (`components/TelegramProvider.tsx`, context): the new field `requestTokenRefresh: () => void` (T3 wires the engine's `onAuthNeeded` to it). `isReady` now means the session settled: bootstrapped, and a JWT exists or the sign-in gave up (`auth_failed`, or `retryCount >= MAX_RETRIES`).

- [ ] **Step 1: Write the failing provider tests.** Replace the whole of `__tests__/unit/telegram-provider-bootstrap.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real TelegramProvider, with the real useJWTRefresh and useReconnectOrchestrator,
// as a plain function with slot-based stand-ins for React's hooks: state and refs persist
// across renders, callbacks and effects follow their deps, effects run after the render that
// queued them, and unmount runs every cleanup. The network, storage, the Telegram WebApp and
// the Supabase client are fakes; timers are fake.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
      return [slot.value, set];
    },
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(() => {
        if (typeof s?.cleanup === "function") s.cleanup();
        R.slots[i].cleanup = fn();
      });
    },
  };
});

type FakeClient = {
  token: string;
  heartbeat: (status: string) => void;
  connected: boolean;
  realtime: { isConnected: () => boolean; setAuth: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  removeAllChannels: ReturnType<typeof vi.fn>;
};
// Stable across renders, like the real hooks' return values.
const H = vi.hoisted(() => ({
  router: { push: (() => {}) as (path: string) => void },
  clients: [] as FakeClient[],
  removeAnswers: [] as string[],
  applyLocale: (() => {}) as (lang: string) => void,
}));
vi.mock("next/navigation", () => ({ useRouter: () => H.router }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({
  createBrowserClient: (token: string, heartbeat: (status: string) => void) => {
    const client: FakeClient = {
      token,
      heartbeat,
      connected: false,
      realtime: { isConnected: () => client.connected, setAuth: vi.fn(async () => {}), disconnect: vi.fn() },
      removeAllChannels: vi.fn(async () => H.removeAnswers),
    };
    H.clients.push(client);
    return client;
  },
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: H.applyLocale, setLanguage: async () => true }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));

import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";

type Ctx = ReturnType<typeof useTelegram>;
type El = ReactElement<{ value: Ctx }>;

const LAUNCH = new Date("2026-10-29T08:00:00.000Z").getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TG_USER = { id: 7, first_name: "A", language_code: "en" };

// A JWT the client can read: the server's claims, a fake signature.
const jwtAt = (issuedMs: number, telegramId = TG_USER.id) =>
  `h.${btoa(JSON.stringify({ iat: Math.floor(issuedMs / 1000), telegram_user_id: telegramId }))}.sig`;
const initDataAt = (authMs: number) =>
  `auth_date=${Math.floor(authMs / 1000)}&user=%7B%22id%22%3A7%7D&hash=secret-hash`;

// How the fake token route answers, one entry per request: a status (200 issues a token),
// a network failure, or held until released.
type Reply = number | "neterr" | "hold";
let tokenReplies: Reply[];
let held: ((status: number) => void) | null;
let issued: string[];
let tokenRequests: Record<string, string>[];
let userRequests: { method: string; headers: Record<string, string> }[];
let userReply: { status: number; body: unknown };
let push: ReturnType<typeof vi.fn>;
let local: Map<string, string>;
let session: Map<string, string>;
let win: EventTarget & { Telegram?: unknown; location: { pathname: string }; matchMedia: () => { matches: boolean } };

const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});

function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; headers: Record<string, string> }) => {
    if (url === "/api/auth/token") {
      tokenRequests.push(init.headers);
      const reply = tokenReplies.shift() ?? 503;
      if (reply === "neterr") throw new TypeError("Load failed");
      const status = reply === "hold" ? await new Promise<number>((r) => (held = r)) : reply;
      if (status !== 200) return { ok: false, status, json: async () => ({ error: "x" }) };
      const token = jwtAt(Date.now());
      issued.push(token);
      return { ok: true, status, json: async () => ({ token }) };
    }
    if (url === "/api/user") {
      userRequests.push({ method: init.method ?? "GET", headers: init.headers });
      return { ok: userReply.status === 200, status: userReply.status, json: async () => userReply.body };
    }
    throw new Error(`unexpected ${url}`);
  }));
}

function miniApp(authMs = LAUNCH) {
  win.Telegram = {
    WebApp: {
      initData: initDataAt(authMs),
      initDataUnsafe: { user: TG_USER },
      ready: () => {},
      expand: () => {},
      onEvent: () => {},
      offEvent: () => {},
    },
  };
}

const render = (): Ctx => {
  R.i = 0;
  R.effects = [];
  const el = TelegramProvider({ children: null }) as El;
  for (const run of R.effects) run();
  return el.props.value;
};
// Lets promises and timers run for `ms`, re-rendering between steps as React would.
async function advance(ms = 0): Promise<Ctx> {
  render();
  const step = 250;
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    render();
  }
  for (let k = 0; k < 10; k++) {
    await vi.advanceTimersByTimeAsync(0);
    render();
  }
  return render();
}
const unmount = () => {
  for (const s of R.slots) if (typeof s?.cleanup === "function") s.cleanup();
};
const focus = () => win.dispatchEvent(new Event("focus"));
// Requests that signed in with initData, and with a bearer token.
const initDataRequests = () => tokenRequests.filter((h) => "x-telegram-init-data" in h);
const bearerRequests = () => tokenRequests.filter((h) => "Authorization" in h);
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(LAUNCH);
  R.slots = [];
  H.clients = [];
  H.removeAnswers = [];
  tokenReplies = [];
  held = null;
  issued = [];
  tokenRequests = [];
  userRequests = [];
  userReply = { status: 200, body: { id: "user-1", language: "en", telegram_id: 7, first_name: "A" } };
  push = vi.fn();
  H.router.push = push as unknown as (path: string) => void;
  local = new Map();
  session = new Map();
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
  win = Object.assign(new EventTarget(), {
    location: { pathname: "/" },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { classList: { add: () => {}, remove: () => {} }, style: { setProperty: () => {} } },
  }));
  stubNetwork();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a failed token refresh keeps the session (H1)", () => {
  it("Mini App: a network failure keeps the JWT, never falls back to stale initData, and the retry refreshes it", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    const launchToken = issued[0];
    vi.setSystemTime(LAUNCH + 25 * HOUR); // the token is due for a refresh; the initData is long stale
    tokenReplies = ["neterr", 200];

    focus();
    let ctx = await advance();
    expect(ctx.jwt).toBe(launchToken);
    expect(ctx.jwtRef.current).toBe(launchToken);
    expect(session.get("tg_auth_token")).toBe(launchToken);
    expect(ctx.connectionStatus).toBe("connecting");
    expect(initDataRequests()).toHaveLength(1); // the launch sign-in only

    ctx = await advance(2000);
    expect(bearerRequests().map((h) => h.Authorization)).toEqual([`Bearer ${launchToken}`, `Bearer ${launchToken}`]);
    expect(ctx.jwt).toBe(issued[1]);
    expect(session.get("tg_auth_token")).toBe(issued[1]);
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("web: a 503 on every retry keeps web_auth_token and never goes to /login", async () => {
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = [200];
    await advance();
    const token = issued[0];
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [503, 503, 503, 503, 503];

    focus();
    const ctx = await advance(12000);
    expect(bearerRequests()).toHaveLength(6);
    expect(push).not.toHaveBeenCalled();
    expect(local.get("web_auth_token")).toBe(token);
    expect(ctx.jwt).toBe(token);
    expect(ctx.retryCount).toBe(5);
    expect(ctx.connectionStatus).toBe("connecting"); // the "Connection problems" banner, not "Session expired"
  });

  it("Mini App: only a refused refresh drops the JWT, and initData older than 5 minutes is not tried", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [401];

    focus();
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(2); // launch + the refused refresh, no initData retry
    expect(ctx.jwt).toBeNull();
    expect(session.has("tg_auth_token")).toBe(false);
    expect(ctx.connectionStatus).toBe("auth_failed");
  });

  it("web: a refused refresh removes the stored login and goes to /login", async () => {
    local.set("web_auth_token", jwtAt(LAUNCH - HOUR));
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [401];

    focus();
    const ctx = await advance();
    expect(local.has("web_auth_token")).toBe(false);
    expect(ctx.jwt).toBeNull();
    expect(push).toHaveBeenCalledWith("/login");
  });

  it("an API refusal inside the first 5 minutes refreshes a young token, then signs in again with the launch initData", async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    vi.setSystemTime(LAUNCH + 2 * MIN);
    tokenReplies = [401, 200];

    ctx.requestTokenRefresh();
    ctx = await advance();
    expect(tokenRequests).toHaveLength(3);
    expect(tokenRequests[1]).toEqual({ Authorization: `Bearer ${issued[0]}` });
    expect(tokenRequests[2]).toEqual({ "x-telegram-init-data": initDataAt(LAUNCH) });
    expect(ctx.jwt).toBe(issued[1]);
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("an API refusal inside the reconnect throttle waits for it instead of being lost", async () => {
    miniApp();
    tokenReplies = [200];
    let ctx = await advance();
    vi.setSystemTime(LAUNCH + 2 * MIN);
    focus(); // a reconnect a moment ago: young token, no request
    ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    tokenReplies = [200];

    ctx.requestTokenRefresh();
    ctx = await advance(1000);
    expect(tokenRequests).toHaveLength(1);
    ctx = await advance(5000);
    expect(tokenRequests).toHaveLength(2);
    expect(ctx.jwt).toBe(issued[1]);
  });
});

describe("a reconnect does only what is needed (H1)", () => {
  it("a token younger than a day is not refreshed, and a live socket is kept", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.clients[0].connected = true;
    vi.setSystemTime(LAUNCH + 3 * HOUR);

    focus();
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    expect(H.clients).toHaveLength(1);
    expect(H.clients[0].realtime.disconnect).not.toHaveBeenCalled();
    expect(H.clients[0].realtime.setAuth).not.toHaveBeenCalled();
    expect(ctx.connectionStatus).toBe("connected");
  });

  it("a refreshed token is handed to the live socket instead of replacing the client", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.clients[0].connected = true;
    vi.setSystemTime(LAUNCH + 25 * HOUR);
    tokenReplies = [200];

    focus();
    await advance();
    expect(H.clients).toHaveLength(1);
    expect(H.clients[0].realtime.setAuth).toHaveBeenCalledWith(issued[1]);
    expect(H.clients[0].realtime.disconnect).not.toHaveBeenCalled();
  });

  it("a socket that is down gets a new client with the current token", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    vi.setSystemTime(LAUNCH + 3 * HOUR);

    H.clients[0].heartbeat("disconnected");
    const ctx = await advance();
    expect(H.clients).toHaveLength(2);
    expect(H.clients[0].realtime.disconnect).toHaveBeenCalled();
    expect(H.clients[0].removeAllChannels).toHaveBeenCalled();
    expect(H.clients[1].token).toBe(issued[0]);
    expect(ctx.supabaseClient).toBe(H.clients[1]);
  });
});

describe("a Telegram reload keeps the session (H2)", () => {
  it("signs in with the tab's stored JWT, not the launch initData, and loads the user with it", async () => {
    const stored = jwtAt(LAUNCH - 10 * MIN);
    session.set("tg_auth_token", stored);
    miniApp(LAUNCH - 10 * MIN); // the reload reuses initData from 10 minutes ago
    tokenReplies = [200];

    const ctx = await advance();
    expect(tokenRequests).toEqual([{ Authorization: `Bearer ${stored}` }]);
    expect(userRequests).toEqual([{ method: "GET", headers: { Authorization: `Bearer ${issued[0]}` } }]);
    expect(ctx.isReady).toBe(true);
    expect(ctx.jwt).toBe(issued[0]);
    expect(ctx.userId).toBe("user-1");
    expect(session.get("tg_auth_token")).toBe(issued[0]);
  });

  it("a fresh launch keeps its JWT in sessionStorage for the next reload, and registers with initData", async () => {
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH) }]);
    expect(session.get("tg_auth_token")).toBe(issued[0]);
    expect(userRequests).toEqual([{ method: "POST", headers: { "x-telegram-init-data": initDataAt(LAUNCH) } }]);
  });

  it("a reload whose sign-in failed still checks the stored JWT with the server on the retry", async () => {
    const stored = jwtAt(LAUNCH - 10 * MIN);
    session.set("tg_auth_token", stored);
    miniApp(LAUNCH - 10 * MIN);
    tokenReplies = ["neterr", 200];

    let ctx = await advance();
    expect(ctx.connectionStatus).toBe("connecting");
    ctx = await advance(2000);
    expect(tokenRequests).toEqual([{ Authorization: `Bearer ${stored}` }, { Authorization: `Bearer ${stored}` }]);
    expect(ctx.jwt).toBe(issued[0]);
  });

  it("at launch the server judges the initData's age, not this device's clock", async () => {
    miniApp(LAUNCH - 6 * MIN); // this device's clock runs ahead of Telegram's
    tokenReplies = [200];

    const ctx = await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH - 6 * MIN) }]);
    expect(ctx.jwt).toBe(issued[0]);
  });

  it("never uses a stored JWT that belongs to another Telegram user", async () => {
    session.set("tg_auth_token", jwtAt(LAUNCH - MIN, 99));
    miniApp();
    tokenReplies = [200];

    await advance();
    expect(tokenRequests).toEqual([{ "x-telegram-init-data": initDataAt(LAUNCH) }]);
  });
});

describe("a failed sign-in at launch hands over to the retry (H10)", () => {
  it("shows 'connecting', not 'connected', stays not ready, and becomes ready when the retry gets a token", async () => {
    miniApp();
    tokenReplies = ["neterr", 200];

    let ctx = await advance();
    expect(ctx.jwt).toBeNull();
    expect(ctx.connectionStatus).toBe("connecting");
    expect(ctx.isReady).toBe(false);
    expect(H.clients).toHaveLength(0);

    ctx = await advance(2000);
    expect(initDataRequests()).toHaveLength(2);
    expect(ctx.jwt).toBe(issued[0]);
    expect(ctx.isReady).toBe(true);
    expect(ctx.connectionStatus).toBe("connected");
    expect(H.clients).toHaveLength(1);
    expect(userRequests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("settles without a token once the retries run out, so screens can show their error", async () => {
    miniApp();
    tokenReplies = ["neterr", "neterr", "neterr", "neterr", "neterr"];

    // The launch sign-in is the first of the 5 attempts.
    const ctx = await advance(12000);
    expect(tokenRequests).toHaveLength(5);
    expect(ctx.jwt).toBeNull();
    expect(ctx.retryCount).toBe(5);
    expect(ctx.isReady).toBe(true);
  });

  it("a focus while the launch sign-in is still waiting starts no second sign-in", async () => {
    miniApp();
    tokenReplies = ["hold"];

    await advance();
    focus();
    await advance();
    expect(tokenRequests).toHaveLength(1);

    held!(200);
    const ctx = await advance();
    expect(tokenRequests).toHaveLength(1);
    expect(ctx.connectionStatus).toBe("connected");
  });
});

describe("the provider cleans up its socket (H23)", () => {
  it("unmount disconnects the client, and a late heartbeat reconnects nothing", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    const client = H.clients[0];

    unmount();
    expect(client.realtime.disconnect).toHaveBeenCalled();
    expect(client.removeAllChannels).toHaveBeenCalled();

    vi.setSystemTime(LAUNCH + 25 * HOUR);
    client.heartbeat("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenRequests).toHaveLength(1);
    expect(H.clients).toHaveLength(1);
  });
});

describe("TelegramProvider logs a failed user load", () => {
  it("Mini App: a refused registration is logged with its status, never the initData", async () => {
    miniApp();
    tokenReplies = [200];
    userReply = { status: 500, body: { error: "Failed to register user" } };

    await advance();
    expect(userRequests).toEqual([{ method: "POST", headers: { "x-telegram-init-data": initDataAt(LAUNCH) } }]);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User registration failed:", { status: 500 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("web app: a refused user load is logged with its status, never the token", async () => {
    const stored = jwtAt(LAUNCH - HOUR);
    local.set("web_auth_token", stored);
    tokenReplies = [200];
    userReply = { status: 503, body: {} };

    await advance();
    expect(userRequests).toEqual([{ method: "GET", headers: { Authorization: `Bearer ${issued[0]}` } }]);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] User load failed:", { status: 503 });
    expect(logged()).not.toContain(issued[0]);
    expect(logged()).not.toContain(stored);
  });
});

describe("TelegramProvider logs a failed cleanup of the old client's channels", () => {
  it("warns with the answers that were not ok when the client is replaced", async () => {
    miniApp();
    tokenReplies = [200];
    await advance();
    H.removeAnswers = ["ok", "timed out"];

    H.clients[0].heartbeat("timeout");
    await advance();
    expect(H.clients).toHaveLength(2);
    expect(H.clients[0].realtime.disconnect).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove all channels failed:", { total: 2 }, ["timed out"]);
  });
});
```

- [ ] **Step 2: Write the failing token tests.** Replace the whole of `__tests__/unit/jwt-refresh-logging.test.ts` with:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useJWTRefresh with slot-based stand-ins for React's hooks.
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], i: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (v: unknown) => { slot.value = v; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
}));

import { useJWTRefresh, isInitDataFresh, readStoredToken, tokenAgeMs } from "@/src/hooks/useJWTRefresh";

const isWebAppRef = { current: false };
const render = () => {
  R.i = 0;
  return useJWTRefresh(isWebAppRef);
};
const INIT_DATA = "query_id=q&user=%7B%7D&hash=secret-hash";
const OLD_JWT = "old.jwt.value";

function stubToken(reply: { ok: boolean; status: number; token?: string }) {
  const f = vi.fn(async () => ({ ok: reply.ok, status: reply.status, json: async () => ({ token: reply.token }) }));
  vi.stubGlobal("fetch", f);
  return f;
}
// Every argument of every console call, flattened to text.
const logged = () =>
  [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

let local: Map<string, string>;
let session: Map<string, string>;
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});

beforeEach(() => {
  R.slots = [];
  isWebAppRef.current = false;
  local = new Map();
  session = new Map();
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useJWTRefresh logs a refused token request", () => {
  it("logs the status of a refused Mini App sign-in, never the initData", async () => {
    stubToken({ ok: false, status: 401 });
    await expect(render().fetchToken(INIT_DATA)).resolves.toEqual({ kind: "unauthorized" });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "initData", status: 401 });
    expect(logged()).not.toContain("secret-hash");
  });

  it("logs the status of a refused token refresh, never the token", async () => {
    const f = stubToken({ ok: false, status: 503 });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(f).toHaveBeenCalledWith("/api/auth/token", { headers: { Authorization: `Bearer ${OLD_JWT}` } });
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Token request failed:", { mode: "bearer", status: 503 });
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("logs nothing and keeps the new token when the server says yes", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    const hook = render();
    await expect(hook.fetchToken(INIT_DATA)).resolves.toEqual({ kind: "ok", token: "new.jwt" });
    expect(hook.jwtRef.current).toBe("new.jwt");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("sends nothing and logs nothing with neither a token nor initData", async () => {
    const f = stubToken({ ok: true, status: 200, token: "x" });
    await expect(render().fetchToken(null)).resolves.toEqual({ kind: "unauthorized" });
    expect(f).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// Only a refusal may end a session (H1): everything that can pass on retry is "transient".
describe("useJWTRefresh tells a refusal from a failure that may pass", () => {
  it.each([429, 500, 502, 503, 408])("a %s is transient and the token is kept", async (status) => {
    stubToken({ ok: false, status });
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(hook.jwtRef.current).toBe(OLD_JWT);
  });

  it("a network failure is transient, keeps the token, and is logged without it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Load failed");
    }));
    const hook = render();
    hook.jwtRef.current = OLD_JWT;
    await expect(hook.fetchToken(null)).resolves.toEqual({ kind: "transient" });
    expect(hook.jwtRef.current).toBe(OLD_JWT);
    expect(console.error).toHaveBeenCalledWith("[TelegramProvider] Token fetch error:", { mode: "bearer" }, expect.any(TypeError));
    expect(logged()).not.toContain(OLD_JWT);
  });

  it("an answer without a token is transient", async () => {
    stubToken({ ok: true, status: 200 });
    await expect(render().fetchToken(INIT_DATA)).resolves.toEqual({ kind: "transient" });
  });
});

describe("useJWTRefresh stores the token where the next load finds it (H2)", () => {
  it("the Mini App keeps it in sessionStorage, for a reload of this tab", async () => {
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    await render().fetchToken(INIT_DATA);
    expect(session.get("tg_auth_token")).toBe("new.jwt");
    expect(local.size).toBe(0);
    expect(readStoredToken(false)).toBe("new.jwt");
  });

  it("the web app keeps it in localStorage, as its login", async () => {
    isWebAppRef.current = true;
    stubToken({ ok: true, status: 200, token: "new.jwt" });
    await render().fetchToken(INIT_DATA);
    expect(local.get("web_auth_token")).toBe("new.jwt");
    expect(session.size).toBe(0);
  });

  it("clearJwt drops the refused token from memory and storage", () => {
    session.set("tg_auth_token", OLD_JWT);
    const hook = render();
    hook.setToken(OLD_JWT);
    hook.clearJwt();
    expect(hook.jwtRef.current).toBeNull();
    expect(render().jwt).toBeNull();
    expect(session.has("tg_auth_token")).toBe(false);
  });

  it("storage that throws is logged, never fatal", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    const hook = render();
    expect(() => hook.setToken("t")).not.toThrow();
    expect(hook.jwtRef.current).toBe("t");
    expect(readStoredToken(false)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[TelegramProvider] Could not store the token:", { isWebApp: false }, expect.any(Error));
  });
});

describe("token and initData age", () => {
  const NOW = new Date("2026-10-29T08:00:00.000Z").getTime();
  const at = (ms: number) => `auth_date=${Math.floor(ms / 1000)}&hash=h`;

  it("initData is fresh for 5 minutes after its auth_date", () => {
    expect(isInitDataFresh(at(NOW - 4 * 60 * 1000), NOW)).toBe(true);
    expect(isInitDataFresh(at(NOW - 6 * 60 * 1000), NOW)).toBe(false);
    expect(isInitDataFresh("hash=h", NOW)).toBe(false);
  });

  it("a token's age comes from its iat; an unreadable one counts as too old", () => {
    const token = `h.${btoa(JSON.stringify({ iat: Math.floor((NOW - 3600 * 1000) / 1000) }))}.s`;
    expect(tokenAgeMs(token, NOW)).toBe(3600 * 1000);
    expect(tokenAgeMs("not-a-jwt", NOW)).toBe(Infinity);
  });
});
```

- [ ] **Step 3: Run them, expect failures.**
  Run: `npx vitest run __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/jwt-refresh-logging.test.ts`
  Expected: `35 failed | 3 passed (38)`. Every `useJWTRefresh` test fails: `isInitDataFresh`, `tokenAgeMs` and `readStoredToken` don't exist, and `fetchToken` resolves `null` or a string, not `{ kind }`. In the provider suite:
  - the H1 network test sees `jwt` cleared and an initData request;
  - the web 503 test sees `/login`;
  - the H10 handover test sees `'connected'` where it expects `'connecting'`;
  - the reload test sees an initData request instead of the bearer;
  - the H23 test sees no `disconnect`.

  Three provider tests already pass today: the same-user guard, the device-clock test and the refused-registration log. They guard the new code against regressions, and Step 8 shows that each one bites.

- [ ] **Step 4: Replace the whole of `src/hooks/useJWTRefresh.ts` with:**

```ts
"use client";

import { useState, useCallback, useRef } from "react";

/** How a token request ended. Only "unauthorized" means the server refused the credential. */
export type TokenResult = { kind: "ok"; token: string } | { kind: "unauthorized" } | { kind: "transient" };

// The web app keeps its login across visits. The Mini App keeps its JWT for the tab session
// only: a Telegram "Reload page" reuses the launch initData, which the server refuses after
// 5 minutes, so the reload must take the bearer path.
const WEB_TOKEN_KEY = "web_auth_token";
const MINI_APP_TOKEN_KEY = "tg_auth_token";

// The server refuses initData older than this (src/lib/telegram-auth.ts).
const INIT_DATA_MAX_AGE_MS = 5 * 60 * 1000;

/** Whether initData is still young enough, by its auth_date, for the server to accept it. */
export function isInitDataFresh(initData: string, now = Date.now()): boolean {
  const authDate = Number(new URLSearchParams(initData).get("auth_date"));
  return authDate > 0 && now - authDate * 1000 < INIT_DATA_MAX_AGE_MS;
}

/** The claims of the app's own JWT (src/lib/jwt.ts) that the client reads. Not verified: the server does that. */
export function readTokenClaims(token: string): { iat?: number; telegram_user_id?: number } | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload));
  } catch (err) {
    console.warn("[TelegramProvider] Unreadable token claims:", err);
    return null;
  }
}

/** Milliseconds since the JWT was issued, or Infinity when that can't be read. */
export function tokenAgeMs(token: string, now = Date.now()): number {
  const iat = readTokenClaims(token)?.iat;
  return typeof iat === "number" ? now - iat * 1000 : Infinity;
}

const tokenStorage = (isWebApp: boolean) => (isWebApp ? localStorage : sessionStorage);
const tokenKey = (isWebApp: boolean) => (isWebApp ? WEB_TOKEN_KEY : MINI_APP_TOKEN_KEY);

/** The token stored by an earlier visit (web) or an earlier load of this tab (Mini App). */
export function readStoredToken(isWebApp: boolean): string | null {
  try {
    return tokenStorage(isWebApp).getItem(tokenKey(isWebApp));
  } catch (err) {
    console.warn("[TelegramProvider] Could not read the stored token:", { isWebApp }, err);
    return null;
  }
}

export function useJWTRefresh(isWebAppRef: React.RefObject<boolean>) {
  const [jwt, setJwt] = useState<string | null>(null);
  const jwtRef = useRef<string | null>(null);

  // Adopts a token: in memory for requests, in state for screens that wait on it, and in
  // storage so the next load starts from it.
  const setToken = useCallback(
    (token: string) => {
      jwtRef.current = token;
      setJwt(token);
      const isWebApp = isWebAppRef.current;
      try {
        tokenStorage(isWebApp).setItem(tokenKey(isWebApp), token);
      } catch (err) {
        console.warn("[TelegramProvider] Could not store the token:", { isWebApp }, err);
      }
    },
    [isWebAppRef]
  );

  const fetchToken = useCallback(
    async (initDataStr: string | null): Promise<TokenResult> => {
      const headers: Record<string, string> = {};
      let mode: "bearer" | "initData";
      if (jwtRef.current) {
        headers["Authorization"] = `Bearer ${jwtRef.current}`;
        mode = "bearer";
      } else if (initDataStr) {
        headers["x-telegram-init-data"] = initDataStr;
        mode = "initData";
      } else {
        return { kind: "unauthorized" }; // nothing to sign in with
      }

      let res: Response;
      try {
        res = await fetch("/api/auth/token", { headers });
      } catch (e) {
        console.error("[TelegramProvider] Token fetch error:", { mode }, e);
        return { kind: "transient" };
      }
      if (!res.ok) {
        // The mode and status only: the token and initData are credentials.
        console.warn("[TelegramProvider] Token request failed:", { mode, status: res.status });
        // Only a 401 refuses the credential. A 429, a 5xx or a proxy error may pass on retry.
        return res.status === 401 ? { kind: "unauthorized" } : { kind: "transient" };
      }
      try {
        const { token } = await res.json();
        if (typeof token !== "string" || !token) throw new Error("No token in the answer");
        setToken(token);
        return { kind: "ok", token };
      } catch (e) {
        console.error("[TelegramProvider] Token answer unreadable:", { mode }, e);
        return { kind: "transient" };
      }
    },
    [setToken]
  );

  // Only for a token the server refused: drops it from memory and from storage.
  const clearJwt = useCallback(() => {
    jwtRef.current = null;
    setJwt(null);
    const isWebApp = isWebAppRef.current;
    try {
      tokenStorage(isWebApp).removeItem(tokenKey(isWebApp));
    } catch (err) {
      console.warn("[TelegramProvider] Could not remove the stored token:", { isWebApp }, err);
    }
  }, [isWebAppRef]);

  return { jwt, jwtRef, fetchToken, setToken, clearJwt };
}
```

- [ ] **Step 5: Replace the whole of `src/hooks/useReconnectOrchestrator.ts` with:**

```ts
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { isInitDataFresh, tokenAgeMs, type TokenResult } from "@/src/hooks/useJWTRefresh";

// --- Orchestrator types ---

type OrchestratorState =
  | "initializing"
  | "idle"
  | "reconnecting"
  | "needs_retry"
  | "cooldown"
  | "auth_failed";

export type ConnectionStatus = "connecting" | "connected" | "auth_failed";

export const MAX_RETRIES = 5;
const COOLDOWN_MS = 5000;
const RETRY_DELAY_MS = 2000;
const RECONNECT_THROTTLE_MS = 5000; // Min interval between reconnect() calls from browser events
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000; // 45 minutes
// JWTs live 7 days (src/lib/jwt.ts), so a reconnect refreshes only a token older than a day.
const TOKEN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

function mapToConnectionStatus(state: OrchestratorState): ConnectionStatus {
  switch (state) {
    case "initializing":
    case "reconnecting":
    case "needs_retry":
      return "connecting";
    case "idle":
    case "cooldown":
      return "connected";
    case "auth_failed":
      return "auth_failed";
  }
}

export function useReconnectOrchestrator(params: {
  fetchToken: (initData: string | null) => Promise<TokenResult>;
  clearJwt: () => void;
  jwtRef: React.RefObject<string | null>;
  syncRealtime: (token: string) => void;
  isWebAppRef: React.RefObject<boolean>;
  onFlushNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onResubscribeNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onRefreshNeededRef: React.MutableRefObject<(() => Promise<void>) | null>;
  router: ReturnType<typeof import("next/navigation").useRouter>;
}) {
  const {
    fetchToken,
    clearJwt,
    jwtRef,
    syncRealtime,
    isWebAppRef,
    onFlushNeededRef,
    onResubscribeNeededRef,
    onRefreshNeededRef,
    router,
  } = params;

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [retryCount, setRetryCount] = useState(0);

  const orchestratorStateRef = useRef<OrchestratorState>("initializing");
  const retryCountRef = useRef(0);
  const cooldownTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tokenRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectLockRef = useRef(false);
  const runReconnectRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const lastReconnectAttemptRef = useRef<number>(0);
  // Set at launch and when an API call was refused: the next token step asks the server
  // whatever the token's age. Cleared once the server answered yes or no.
  const forceTokenRefreshRef = useRef(false);

  const setOrchestratorState = useCallback(
    (state: OrchestratorState) => {
      orchestratorStateRef.current = state;
      setConnectionStatus(mapToConnectionStatus(state));
    },
    []
  );

  // A token to work with. The current one is kept while it is younger than a day; a failed
  // refresh keeps it too, and only a refusal (401) drops it. The Mini App then signs in again
  // with its initData: at launch whatever its age (the server's clock decides), later only
  // while it is younger than the server's 5-minute limit.
  const ensureToken = useCallback(
    async (atLaunch: boolean): Promise<TokenResult> => {
      const current = jwtRef.current;
      if (current && !forceTokenRefreshRef.current && tokenAgeMs(current) < TOKEN_REFRESH_AGE_MS) {
        return { kind: "ok", token: current };
      }
      let result: TokenResult = { kind: "unauthorized" };
      if (current) {
        result = await fetchToken(null);
        if (result.kind === "unauthorized") clearJwt();
      }
      if (result.kind === "unauthorized" && !isWebAppRef.current) {
        const initData = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;
        if (initData && (atLaunch || isInitDataFresh(initData))) result = await fetchToken(initData);
      }
      if (result.kind !== "transient") forceTokenRefreshRef.current = false;
      return result;
    },
    [fetchToken, clearJwt, jwtRef, isWebAppRef]
  );

  // Every credential was refused: the web app goes to its login page, the Mini App shows
  // "Session expired" (only reopening it from Telegram brings fresh initData).
  const endSession = useCallback(() => {
    clearJwt();
    setOrchestratorState("auth_failed");
    if (isWebAppRef.current) router.push("/login");
  }, [clearJwt, setOrchestratorState, isWebAppRef, router]);

  // A failed attempt: retry after a delay, until MAX_RETRIES; then the banner offers a manual retry.
  const scheduleRetry = useCallback(() => {
    retryCountRef.current++;
    setRetryCount(retryCountRef.current);
    setOrchestratorState("needs_retry");
    if (retryCountRef.current >= MAX_RETRIES) return;
    // Clear previous retry timeout to prevent orphaned timers
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }
    retryTimeoutRef.current = setTimeout(() => {
      // Reset to idle so runReconnect can proceed
      orchestratorStateRef.current = "idle";
      runReconnectRef.current();
    }, RETRY_DELAY_MS);
  }, [setOrchestratorState]);

  // === Reconnect Orchestrator ===

  const runReconnect = useCallback(async () => {
    // Only proceed from idle state
    if (orchestratorStateRef.current !== "idle") return;
    // Mutex: prevent concurrent reconnect calls
    if (reconnectLockRef.current) return;
    reconnectLockRef.current = true;

    setOrchestratorState("reconnecting");

    try {
      // Step 1: a token (asks the server only when the current one is old or was refused)
      const token = await ensureToken(false);
      if (token.kind === "unauthorized") {
        endSession();
        return;
      }
      if (token.kind === "transient") throw new Error("Token request failed");

      // The realtime client: kept while its socket is up, replaced only when it is down
      syncRealtime(token.token);

      // Step 2: Flush mutations (no-op if no list page mounted)
      if (onFlushNeededRef.current) {
        await onFlushNeededRef.current();
      }

      // Step 3: Rejoin realtime if the channel is not joined (no-op if no list page mounted)
      if (onResubscribeNeededRef.current) {
        await onResubscribeNeededRef.current();
      }

      // Step 4: Refresh server state (home page or list page)
      if (onRefreshNeededRef.current) {
        await onRefreshNeededRef.current();
      }

      // Success — enter cooldown
      retryCountRef.current = 0;
      setRetryCount(0);
      setOrchestratorState("cooldown");
      cooldownTimeoutRef.current = setTimeout(() => {
        if (orchestratorStateRef.current === "cooldown") {
          setOrchestratorState("idle");
        }
      }, COOLDOWN_MS);
    } catch (error) {
      console.error("[Orchestrator] Partial failure:", error);
      scheduleRetry();
    } finally {
      reconnectLockRef.current = false;
    }
  }, [ensureToken, endSession, syncRealtime, scheduleRetry, setOrchestratorState, onFlushNeededRef, onResubscribeNeededRef, onRefreshNeededRef]);

  // Keep refs in sync for stable callbacks
  runReconnectRef.current = runReconnect;

  // The bootstrap's sign-in. It always asks the server, so a stored token is checked rather
  // than trusted. A failure that may pass counts as the first attempt and hands over to the
  // reconnect retry and its backoff.
  const startSession = useCallback(async () => {
    forceTokenRefreshRef.current = true;
    const token = await ensureToken(true);
    if (token.kind === "ok") {
      syncRealtime(token.token);
      setOrchestratorState("idle");
    } else if (token.kind === "unauthorized") {
      endSession();
    } else {
      console.warn("[Orchestrator] Sign-in at launch failed, handing over to the retry");
      scheduleRetry();
    }
  }, [ensureToken, endSession, syncRealtime, scheduleRetry, setOrchestratorState]);

  // Manual reconnect (works even when retryCount >= MAX_RETRIES)
  const reconnect = useCallback(() => {
    // If a reconnect is already in flight, don't interfere
    if (reconnectLockRef.current) return;
    // The bootstrap is still signing in; it hands over to the retry itself.
    if (orchestratorStateRef.current === "initializing") return;
    // Clear any pending timers
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (cooldownTimeoutRef.current) {
      clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = null;
    }
    // Reset retry count
    retryCountRef.current = 0;
    setRetryCount(0);
    // Force state to idle so runReconnect proceeds
    orchestratorStateRef.current = "idle";
    runReconnect();
  }, [runReconnect]);

  // Keep reconnect ref in sync
  reconnectRef.current = reconnect;

  // Throttled reconnect for browser event handlers (online, visibilitychange).
  // Prevents retry storms when network flaps rapidly.
  const debouncedReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAttemptRef.current < RECONNECT_THROTTLE_MS) return;
    lastReconnectAttemptRef.current = now;
    reconnectRef.current();
  }, []);

  // An API call was refused with a 401: reconnect with a token refresh whatever the token's
  // age. Throttled like the browser events, so a run of refusals can't storm the token route;
  // a call inside the throttle window waits for it instead of being lost.
  const requestTokenRefresh = useCallback(() => {
    forceTokenRefreshRef.current = true;
    if (tokenRefreshTimeoutRef.current) return;
    const wait = lastReconnectAttemptRef.current + RECONNECT_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      debouncedReconnect();
      return;
    }
    tokenRefreshTimeoutRef.current = setTimeout(() => {
      tokenRefreshTimeoutRef.current = null;
      debouncedReconnect();
    }, wait);
  }, [debouncedReconnect]);

  // === Entry Points Effect ===
  useEffect(() => {
    const handleOnline = () => {
      debouncedReconnect();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        debouncedReconnect();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", debouncedReconnect);
    document.addEventListener("visibilitychange", handleVisibility);

    // 45-minute proactive timer: flush, rejoin and refresh during stable use (the token is
    // refreshed once it is a day old)
    const proactiveTimer = setInterval(() => {
      runReconnectRef.current();
    }, PROACTIVE_REFRESH_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", debouncedReconnect);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(proactiveTimer);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      if (tokenRefreshTimeoutRef.current) clearTimeout(tokenRefreshTimeoutRef.current);
    };
  }, [debouncedReconnect]);

  return {
    connectionStatus,
    retryCount,
    reconnect,
    runReconnectRef,
    startSession,
    requestTokenRefresh,
  };
}
```

- [ ] **Step 6: Edit `components/TelegramProvider.tsx`.** Each pair is exact current text → replacement.

  Apply the pairs in order; each Replace text occurs exactly once in the file when its turn comes.

  1. Replace:

```tsx
import { useJWTRefresh } from "@/src/hooks/useJWTRefresh";
import { useLocaleSync } from "@/src/hooks/useLocaleSync";
import { useHomeScreen } from "@/src/hooks/useHomeScreen";
import { useReconnectOrchestrator } from "@/src/hooks/useReconnectOrchestrator";
```

  with:

```tsx
import { useJWTRefresh, isInitDataFresh, readStoredToken, readTokenClaims } from "@/src/hooks/useJWTRefresh";
import { useLocaleSync } from "@/src/hooks/useLocaleSync";
import { useHomeScreen } from "@/src/hooks/useHomeScreen";
import { useReconnectOrchestrator, MAX_RETRIES } from "@/src/hooks/useReconnectOrchestrator";
```

  2. Replace:

```tsx
  isReady: boolean;
  connectionStatus: ConnectionStatus;
  reconnect: () => void;
```

  with:

```tsx
  /** The session has settled: a JWT exists, or the sign-in gave up (refused, or out of retries). */
  isReady: boolean;
  connectionStatus: ConnectionStatus;
  reconnect: () => void;
  /** An API call answered 401: reconnect with a token refresh, whatever the token's age. */
  requestTokenRefresh: () => void;
```

  3. Replace:

```tsx
  connectionStatus: "connecting",
  reconnect: () => {},
  retryCount: 0,
  homeScreenStatus: null,
```

  with:

```tsx
  connectionStatus: "connecting",
  reconnect: () => {},
  requestTokenRefresh: () => {},
  retryCount: 0,
  homeScreenStatus: null,
```

  4. Replace:

```tsx
  const [isReady, setIsReady] = useState(false);

  const router = useRouter();
  const supabaseClientRef = useRef<SupabaseClient | null>(null);
```

  with:

```tsx
  const [bootstrapped, setBootstrapped] = useState(false);

  const router = useRouter();
  const supabaseClientRef = useRef<SupabaseClient | null>(null);
  // The token the realtime client was last given.
  const realtimeTokenRef = useRef<string | null>(null);
  // Set on unmount: an in-flight reconnect or a late heartbeat must not revive a client.
  const unmountedRef = useRef(false);
  // The user record is loaded once per session.
  const userLoadedRef = useRef(false);
```

  5. Replace:

```tsx
  // --- Extracted hooks ---
  const { jwt, jwtRef, fetchToken, clearJwt } = useJWTRefresh();
  const { locale, applyLocale, setLanguage } = useLocaleSync(jwtRef);
```

  with:

```tsx
  // --- Extracted hooks ---
  const { jwt, jwtRef, fetchToken, setToken, clearJwt } = useJWTRefresh(isWebAppRef);
  const { locale, applyLocale, setLanguage } = useLocaleSync(jwtRef);
```

  6. Replace:

```tsx
  const stableHeartbeatCallback = useCallback(
    (status: string) => {
      if (status === "timeout" || status === "disconnected") {
        runReconnectRef_local.current();
```

  with:

```tsx
  const stableHeartbeatCallback = useCallback(
    (status: string) => {
      if (unmountedRef.current) return;
      if (status === "timeout" || status === "disconnected") {
        runReconnectRef_local.current();
```

  7. Replace:

```tsx
  const recreateSupabaseClient = useCallback(
    (token: string) => {
      const oldClient = supabaseClientRef.current;
      if (oldClient) {
        oldClient.realtime.disconnect();
        removeAllChannelsLogged(oldClient);
      }
      const newClient = createBrowserClient(token, stableHeartbeatCallback);
```

  with:

```tsx
  // The realtime client follows the session: while its socket is up it is kept and given a
  // new token; it is replaced only when the socket is down.
  const syncRealtime = useCallback(
    (token: string) => {
      if (unmountedRef.current) return;
      const client = supabaseClientRef.current;
      if (client?.realtime.isConnected()) {
        if (realtimeTokenRef.current !== token) {
          realtimeTokenRef.current = token;
          client.realtime.setAuth(token).catch((err) => {
            console.warn("[TelegramProvider] Realtime token update failed:", err);
          });
        }
        return;
      }
      if (client) {
        client.realtime.disconnect();
        removeAllChannelsLogged(client);
      }
      const newClient = createBrowserClient(token, stableHeartbeatCallback);
      realtimeTokenRef.current = token;
```

  8. Replace:

```tsx
    runReconnectRef,
    setOrchestratorState,
  } = useReconnectOrchestrator({
```

  with:

```tsx
    runReconnectRef,
    startSession,
    requestTokenRefresh,
  } = useReconnectOrchestrator({
```

  9. Replace:

```tsx
    jwtRef,
    recreateSupabaseClient,
    isWebAppRef,
```

  with:

```tsx
    jwtRef,
    syncRealtime,
    isWebAppRef,
```

  10. Replace:

```tsx

      // Web app flow: check for stored JWT
      const storedToken = localStorage.getItem("web_auth_token");
      if (!storedToken) {
```

  with:

```tsx

      // Web app flow: the login stored a JWT
      const storedToken = readStoredToken(true);
      if (!storedToken) {
```

  11. Replace:

```tsx

      // Try to refresh the stored JWT
      jwtRef.current = storedToken;
      (async () => {
        const token = await fetchToken(null); // Bearer refresh path
        if (!token) {
          // Stored token invalid/expired — redirect to login
          localStorage.removeItem("web_auth_token");
          jwtRef.current = null;
          router.push("/login");
          return;
        }

        // Persist refreshed token
        localStorage.setItem("web_auth_token", token);
        recreateSupabaseClient(token);

        // Fetch user info via JWT (user was already upserted during login)
        try {
          const userRes = await fetch("/api/user", {
            headers: { Authorization: `Bearer ${token}` },
          });
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
          } else {
            console.error("[TelegramProvider] Web user load failed:", { status: userRes.status });
          }
        } catch (e) {
          console.error("[TelegramProvider] Web user registration error:", e);
        }

        // Apply locale from localStorage
        try {
          const cached = localStorage.getItem("app_locale");
          if (cached && ["en", "he", "ru"].includes(cached)) {
            applyLocale(cached as SupportedLocale);
          }
        } catch (err) {
          console.warn("[TelegramProvider] Could not read cached locale from localStorage:", err);
        }

        setIsReady(true);
        setOrchestratorState("idle");
```

  with:

```tsx
      setToken(storedToken);

      // Apply locale from localStorage
      try {
        const cached = localStorage.getItem("app_locale");
        if (cached && ["en", "he", "ru"].includes(cached)) {
          applyLocale(cached as SupportedLocale);
        }
      } catch (err) {
        console.warn("[TelegramProvider] Could not read cached locale from localStorage:", err);
      }

      // Checks the stored JWT with the server (only a refusal goes to /login)
      (async () => {
        await startSession();
        setBootstrapped(true);
```

  12. Replace:

```tsx
    // Fetch JWT and setup
    (async () => {
      const token = await fetchToken(rawInitData);
      if (token) {
        recreateSupabaseClient(token);
      }

      // Register user (uses initData for TelegramUser fields)
      if (rawInitData) {
        try {
          const userRes = await fetch("/api/user", {
            method: "POST",
            headers: { "x-telegram-init-data": rawInitData },
          });
          if (userRes.ok) {
            const userData2 = await userRes.json();
            if (userData2?.id) setUserId(userData2.id);
            // Server-stored language is authoritative
            if (userData2?.language) {
              const serverLocale = resolveLocale(userData2.language);
              applyLocale(serverLocale);
            }
            // Language is user-controlled via the language sheet — never overwrite it from
            // Telegram's language_code, since unsupported codes (e.g. "en-US") would be
            // normalized to "en" by resolveLocale and clobber the user's explicit choice.
          } else {
            console.error("[TelegramProvider] User registration failed:", { status: userRes.status });
          }
        } catch (e) {
          console.error("[TelegramProvider] User registration error:", e);
        }
      }
```

  with:

```tsx
    // A reload of this tab (Telegram "Reload page") finds its JWT in sessionStorage, if it
    // belongs to the same Telegram user, and signs in with it instead of the launch initData.
    const storedToken = readStoredToken(false);
    if (storedToken && userData?.id && readTokenClaims(storedToken)?.telegram_user_id === userData.id) {
      setToken(storedToken);
    }

    // Sign in, then setup
    (async () => {
      await startSession();
```

  13. Replace:

```tsx
      }

      setIsReady(true);
      setOrchestratorState("idle");

      // Check home screen status (Telegram Bot API 8.0+)
```

  with:

```tsx
      }

      setBootstrapped(true);

      // Check home screen status (Telegram Bot API 8.0+)
```

  14. Replace:

```tsx
  }, []);

  return (
    <TelegramContext.Provider
```

  with:

```tsx
  }, []);

  // Settled once the bootstrap ran and a JWT exists or the sign-in gave up, so a screen
  // waits through the retries and loads (or shows its error) when they end.
  const isReady =
    bootstrapped && (jwt !== null || connectionStatus === "auth_failed" || retryCount >= MAX_RETRIES);

  // Who the user is, once per session and once a JWT exists. The Mini App registers with its
  // initData while that is fresh (a new user gets their Telegram language); otherwise, and on
  // the web, the JWT identifies the user.
  const loadUser = useCallback(
    async (token: string) => {
      const register = !isWebAppRef.current && !!initData && isInitDataFresh(initData);
      try {
        const userRes = register
          ? await fetch("/api/user", { method: "POST", headers: { "x-telegram-init-data": initData! } })
          : await fetch("/api/user", { headers: { Authorization: `Bearer ${token}` } });
        if (!userRes.ok) {
          console.error(
            register ? "[TelegramProvider] User registration failed:" : "[TelegramProvider] User load failed:",
            { status: userRes.status }
          );
          return;
        }
        const userData = await userRes.json();
        if (userData?.id) setUserId(userData.id);
        // Server-stored language is authoritative. Language is user-controlled via the
        // language sheet — never overwrite it from Telegram's language_code, since unsupported
        // codes (e.g. "en-US") would be normalized to "en" by resolveLocale and clobber the
        // user's explicit choice.
        if (userData?.language) applyLocale(resolveLocale(userData.language));
        // The Mini App has its user from initDataUnsafe; the web app only from this record.
        if (isWebAppRef.current && userData?.first_name) {
          setUser({
            id: userData.telegram_id,
            first_name: userData.first_name,
            last_name: userData.last_name,
            username: userData.username,
          });
        }
      } catch (e) {
        console.error("[TelegramProvider] User load error:", { register }, e);
      }
    },
    [initData, applyLocale]
  );

  useEffect(() => {
    if (!isReady || !jwt || userLoadedRef.current) return;
    userLoadedRef.current = true;
    void loadUser(jwt);
  }, [isReady, jwt, loadUser]);

  // Unmount (leaving the signed-in screens): close the socket, so its heartbeat can't
  // reconnect a provider that is gone.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      const client = supabaseClientRef.current;
      supabaseClientRef.current = null;
      if (client) {
        client.realtime.disconnect();
        removeAllChannelsLogged(client);
      }
    };
  }, []);

  return (
    <TelegramContext.Provider
```

  15. Replace:

```tsx
        connectionStatus,
        reconnect,
        retryCount,
        homeScreenStatus,
```

  with:

```tsx
        connectionStatus,
        reconnect,
        requestTokenRefresh,
        retryCount,
        homeScreenStatus,
```


- [ ] **Step 7: Run green.**

```bash
npx vitest run __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/jwt-refresh-logging.test.ts
npx vitest run
npx tsc --noEmit
npx eslint components/TelegramProvider.tsx src/hooks/useJWTRefresh.ts src/hooks/useReconnectOrchestrator.ts __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/jwt-refresh-logging.test.ts
```
  Expected: 21 + 17 tests pass, the full suite is green (`no-silent-catches.test.ts` included), and tsc and eslint print nothing.

- [ ] **Step 8: Make it bite.** Make each edit, run `npx vitest run __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/jwt-refresh-logging.test.ts`, see the named test go red, then restore:

| Edit | Goes red |
|---|---|
| `useJWTRefresh.ts`: `return res.status === 401 ? { kind: "unauthorized" } : { kind: "transient" };` → `return { kind: "unauthorized" };` | "a 429 is transient and the token is kept" (and 500/502/503/408), "logs the status of a refused token refresh, never the token" |
| `useJWTRefresh.ts`: in the fetch catch, `return { kind: "transient" };` → `return { kind: "unauthorized" };` | "a network failure is transient, keeps the token…", "Mini App: a network failure keeps the JWT…" |
| `useJWTRefresh.ts`: delete `tokenStorage(isWebApp).setItem(tokenKey(isWebApp), token);` | "the Mini App keeps it in sessionStorage…", "the web app keeps it in localStorage…" |
| `useJWTRefresh.ts`: delete `tokenStorage(isWebApp).removeItem(tokenKey(isWebApp));` | "clearJwt drops the refused token…", "web: a refused refresh removes the stored login…" |
| Orchestrator: `tokenAgeMs(current) < TOKEN_REFRESH_AGE_MS` → `false` | "a token younger than a day is not refreshed, and a live socket is kept" |
| Orchestrator: delete `if (result.kind === "unauthorized") clearJwt();` in `ensureToken` | "an API refusal inside the first 5 minutes refreshes a young token, then signs in again with the launch initData" |
| Orchestrator: `(atLaunch \|\| isInitDataFresh(initData))` → `true` | "Mini App: only a refused refresh drops the JWT, and initData older than 5 minutes is not tried" |
| Orchestrator: `(atLaunch \|\| isInitDataFresh(initData))` → `isInitDataFresh(initData)` | "at launch the server judges the initData's age, not this device's clock" |
| Orchestrator: delete `forceTokenRefreshRef.current = true;` in `startSession` | "signs in with the tab's stored JWT…", "web: a 503 on every retry…" |
| Orchestrator: `if (result.kind !== "transient") forceTokenRefreshRef.current = false;` → `forceTokenRefreshRef.current = false;` | "a reload whose sign-in failed still checks the stored JWT with the server on the retry" |
| Orchestrator: `if (token.kind === "transient") throw new Error("Token request failed");` → `if (token.kind === "transient") { endSession(); return; }` | "web: a 503 on every retry keeps web_auth_token and never goes to /login" |
| Orchestrator: delete `if (orchestratorStateRef.current === "initializing") return;` in `reconnect` | "a focus while the launch sign-in is still waiting starts no second sign-in" |
| Orchestrator: in `startSession`, replace the `console.warn(...)` + `scheduleRetry();` lines with `setOrchestratorState("idle");` | "shows 'connecting', not 'connected', stays not ready…" |
| Orchestrator: `if (wait <= 0) {` → `if (wait <= 0 \|\| true) {` | "an API refusal inside the reconnect throttle waits for it instead of being lost" |
| Provider: the `isReady` expression → `bootstrapped;` | "shows 'connecting', not 'connected', stays not ready…" |
| Provider: drop ` \|\| retryCount >= MAX_RETRIES` from `isReady` | "settles without a token once the retries run out…" |
| Provider: `if (client?.realtime.isConnected()) {` → `if (false) {` | "a token younger than a day is not refreshed, and a live socket is kept", "a refreshed token is handed to the live socket…" |
| Provider: `client.realtime.setAuth(token).catch(` → `Promise.resolve().catch(` | "a refreshed token is handed to the live socket instead of replacing the client" |
| Provider: the stored-token condition → `if (storedToken) {` | "never uses a stored JWT that belongs to another Telegram user" |
| Provider: delete `setToken(storedToken);` in the Mini App bootstrap | "signs in with the tab's stored JWT, not the launch initData…" |
| Provider: `const register = !isWebAppRef.current && !!initData && isInitDataFresh(initData);` → drop `&& isInitDataFresh(initData)` | "signs in with the tab's stored JWT… and loads the user with it" |
| Provider: delete `if (unmountedRef.current) return;` in `stableHeartbeatCallback` | "unmount disconnects the client, and a late heartbeat reconnects nothing" |
| Provider: delete the `if (client) { client.realtime.disconnect(); removeAllChannelsLogged(client); }` block in the unmount effect | "unmount disconnects the client…" |

- [ ] **Step 9: Commit.**

```bash
git add src/hooks/useJWTRefresh.ts src/hooks/useReconnectOrchestrator.ts components/TelegramProvider.tsx __tests__/unit/telegram-provider-bootstrap.test.ts __tests__/unit/jwt-refresh-logging.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): keep the session through failed refreshes and reloads

fetchToken now says why it failed (ok / unauthorized / transient). A network
error, 429 or 5xx keeps the JWT and retries; only a 401 clears it, and the
Mini App falls back to initData only while it is fresh (H1). Reconnects
refresh a token only past a day old, hand a new token to a live socket with
setAuth, and replace the client only when its socket is down. The Mini App
JWT is kept in sessionStorage, so a Telegram "Reload page" signs in with it
(H2). A failed launch sign-in hands over to the retry instead of showing
"connected", and isReady waits for the session to settle (H10). The provider
disconnects its socket on unmount (H23). requestTokenRefresh serves API 401s.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 1c: One live channel per list across reconnects

**Files:**
- Modify (whole file): `src/hooks/useRealtimeList.ts`
- Test (modify): `__tests__/unit/realtime-cleanup.test.ts`
- Test (rewrite): `__tests__/unit/realtime-subscribe-logging.test.ts`. It was a source inspection of two `channel.subscribe((status` bodies, and there is now one subscribe callback. It becomes a behavioral test of the same rule: a failed join is warned with its error.

**Interfaces:**
- Consumes: `supabaseClient` / `supabaseClientRef` from `useTelegram()` (1b: the client is replaced only when its socket is down); `removeChannelLogged` (unchanged).
- Produces: `useRealtimeList(supabaseClient, supabaseClientRef, listId, onChange): { resubscribe: () => Promise<void> }`. The signature is unchanged. `resubscribe` resolves at once while the channel is joined, waits for a join in progress, and rejects on `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` or after 10 s. The single subscribe status callback lives in `subscribe(client)`, which T4 extends for the catch-up refresh. The warn text is now `"[RealtimeList] Subscribe failed:"`, status, `"listId:"`, listId, err.

- [ ] **Step 1: Update and add the failing tests in `__tests__/unit/realtime-cleanup.test.ts`.**

  Replace:
```ts
  // The subscribe effect is the one that depends on the client.
  const subscribeEffect = () => R.effects.find((e) => e.deps?.includes(ref))!;
```
  with:
```ts
  // The subscribe effect is the one that depends on the list id.
  const subscribeEffect = () => R.effects.find((e) => e.deps?.includes("L"))!;
```

  The old test pinned a same-client replacement with reason `"replaced"`, which no longer exists, so it now pins the new contract. Replace:
```ts
  it("logs a failed removal of the channel it replaces", async () => {
    const { client, channels, sb } = fakeClient(async () => "timed out");
    render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    render(sb);
    subscribeEffect().fn();
    await settle();
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(console.warn).toHaveBeenCalledWith("[Realtime] Remove channel failed:", { listId: "L", reason: "replaced" }, "timed out");
  });
```
  with:
```ts
  // A second run of the effect on the same client used to replace the channel (reason
  // "replaced"); it now keeps it, so there is no replacement left to log (H23).
  it("a second run of the effect on the same client keeps its channel", async () => {
    const { client, channels, sb } = fakeClient(async () => "timed out");
    render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    render(sb);
    subscribeEffect().fn();
    await settle();
    expect(channels).toHaveLength(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
  });
```

  Insert this block directly above the comment line `// The helpers are the one code path for channel removal`:
```ts
// The effect and the orchestrator's rejoin used to each create a channel, and unmount removed
// only one of them (H23).
describe("useRealtimeList keeps one channel per list (H23)", () => {
  const ref: { current: SupabaseClient | null } = { current: null };
  const render = (client: SupabaseClient | null) => {
    R.i = 0;
    R.effects = [];
    ref.current = client;
    return useRealtimeList(client, ref, "L", () => {});
  };
  const subscribeEffect = () => R.effects.find((e) => e.deps?.includes("L"))!;

  it("a rejoin that runs before the client effect shares its channel", async () => {
    const { client, channels, sb } = fakeClient(async () => "ok");
    const { resubscribe } = render(sb);
    let joined = false;
    const done = resubscribe().then(() => (joined = true));
    subscribeEffect().fn();
    expect(client.channel).toHaveBeenCalledTimes(1);
    channels[0].cb!("SUBSCRIBED");
    await done;
    expect(joined).toBe(true);
  });

  it("a rejoin while the channel is joined creates nothing and resolves at once", async () => {
    const { client, channels, sb } = fakeClient(async () => "ok");
    const { resubscribe } = render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    await resubscribe();
    expect(client.channel).toHaveBeenCalledTimes(1);
  });

  it("a rejoin waits for supabase-js's own rejoin of a channel that errored", async () => {
    const { client, channels, sb } = fakeClient(async () => "ok");
    const { resubscribe } = render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    const done = resubscribe();
    channels[0].cb!("SUBSCRIBED");
    await done;
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("after a new client, only its one channel is live, and unmount removes it", async () => {
    const first = fakeClient(async () => "ok");
    const second = fakeClient(async () => "ok");
    render(first.sb);
    const firstCleanup = subscribeEffect().fn() as () => void;
    first.channels[0].cb!("SUBSCRIBED");

    // The provider replaced the client: the rejoin runs before React re-renders the page.
    const { resubscribe } = render(second.sb);
    const done = resubscribe();
    firstCleanup();
    const secondCleanup = subscribeEffect().fn() as () => void;
    expect(second.client.channel).toHaveBeenCalledTimes(1);
    second.channels[0].cb!("SUBSCRIBED");
    await done;

    secondCleanup();
    expect(second.client.removeChannel).toHaveBeenCalledWith(second.channels[0]);
  });

  it("a channel closed for good is replaced by the next rejoin", async () => {
    const { client, channels, sb } = fakeClient(async () => "ok");
    const { resubscribe } = render(sb);
    subscribeEffect().fn();
    channels[0].cb!("SUBSCRIBED");
    channels[0].cb!("CLOSED");
    const done = resubscribe();
    expect(client.channel).toHaveBeenCalledTimes(2);
    channels[1].cb!("SUBSCRIBED");
    await done;
  });
});
```

- [ ] **Step 2: Replace the whole of `__tests__/unit/realtime-subscribe-logging.test.ts` with:**

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The subscribe status callback is not a try/catch handler, so the no-silent-catches guard
// cannot see it. This runs the real useRealtimeList (slot-based React stand-ins, effects run
// by the test) and pins that a failed join is logged with its error.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { current: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.effects.push({ fn, deps });
    R.i++;
  },
}));

import { useRealtimeList } from "@/src/hooks/useRealtimeList";

type Cb = (status: string, err?: Error) => void;

function fakeClient() {
  const callbacks: Cb[] = [];
  const client = {
    channel: vi.fn(() => {
      const ch = { on: () => ch, subscribe: (cb: Cb) => (callbacks.push(cb), ch) };
      return ch;
    }),
    removeChannel: vi.fn(async () => "ok"),
  };
  return { callbacks, sb: client as unknown as SupabaseClient };
}

const ref: { current: SupabaseClient | null } = { current: null };
const render = (client: SupabaseClient) => {
  R.i = 0;
  R.effects = [];
  ref.current = client;
  return useRealtimeList(client, ref, "L", () => {});
};
const runSubscribeEffect = () => R.effects.find((e) => e.deps?.includes("L"))!.fn();

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("realtime subscribe status callbacks log failures", () => {
  it.each(["CHANNEL_ERROR", "TIMED_OUT"])("a %s on the first join is warned with its error", (status) => {
    const { callbacks, sb } = fakeClient();
    render(sb);
    runSubscribeEffect();
    const err = new Error("denied");
    callbacks[0](status, err);
    expect(console.warn).toHaveBeenCalledWith("[RealtimeList] Subscribe failed:", status, "listId:", "L", err);
  });

  it("a failed join a rejoin waited on is warned with its error", async () => {
    const { callbacks, sb } = fakeClient();
    const { resubscribe } = render(sb);
    const done = resubscribe();
    const err = new Error("denied");
    callbacks[0]("CHANNEL_ERROR", err);
    await expect(done).rejects.toThrow("Channel subscribe failed: CHANNEL_ERROR");
    expect(console.warn).toHaveBeenCalledWith("[RealtimeList] Subscribe failed:", "CHANNEL_ERROR", "listId:", "L", err);
  });

  it("a join and a normal close are not warned", () => {
    const { callbacks, sb } = fakeClient();
    render(sb);
    runSubscribeEffect();
    callbacks[0]("SUBSCRIBED");
    callbacks[0]("CLOSED");
    expect(console.warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them, expect failures.**
  Run: `npx vitest run __tests__/unit/realtime-cleanup.test.ts __tests__/unit/realtime-subscribe-logging.test.ts`
  Expected: 8 failed. Each item names the test and what it gets today:
  - "a second run of the effect on the same client keeps its channel": `expected [..] to have a length of 1 but got 2`
  - "a rejoin that runs before the client effect shares its channel": `channel` called 2 times
  - "after a new client, only its one channel is live…": 2 times
  - "a rejoin while the channel is joined…" and "a rejoin waits for supabase-js's own rejoin…": time out after 5 s, because today's resubscribe always makes a new channel
  - the three warn tests: the message text is new

  "a channel closed for good is replaced by the next rejoin" passes today, because today's resubscribe always creates a channel. Step 6 bites it.

- [ ] **Step 4: Replace the whole of `src/hooks/useRealtimeList.ts` with:**

```ts
"use client";

import { useEffect, useRef, useCallback } from "react";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { RealtimeChange } from "@/src/types";
import { removeChannelLogged } from "@/src/lib/realtime-cleanup";

const RESUBSCRIBE_TIMEOUT_MS = 10000;

// The list's channel and its join. There is at most one, so a list never has two live
// channels (each would apply every event).
type Subscription = {
  client: SupabaseClient;
  channel: RealtimeChannel;
  joined: boolean;
  // Rejoins waiting for the join to end
  waiters: { resolve: () => void; reject: (err: Error) => void }[];
};

export function useRealtimeList(
  supabaseClient: SupabaseClient | null,
  supabaseClientRef: React.RefObject<SupabaseClient | null>,
  listId: string,
  onChange: (change: RealtimeChange) => void
) {
  const subRef = useRef<Subscription | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const subscribeCountRef = useRef(0);

  const createChannel = useCallback(
    (client: SupabaseClient, channelName: string): RealtimeChannel => {
      return client
        .channel(channelName)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "items",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            onChangeRef.current({
              table: "items",
              eventType: payload.eventType as RealtimeChange["eventType"],
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "lists",
            filter: `id=eq.${listId}`,
          },
          (payload) => {
            onChangeRef.current({
              table: "lists",
              eventType: payload.eventType as RealtimeChange["eventType"],
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "collaborators",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            onChangeRef.current({
              table: "collaborators",
              eventType: payload.eventType as RealtimeChange["eventType"],
              new: payload.new,
              old: payload.old,
            });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "list_categories",
            filter: `list_id=eq.${listId}`,
          },
          (payload) => {
            onChangeRef.current({
              table: "list_categories",
              eventType: payload.eventType as RealtimeChange["eventType"],
              new: payload.new,
              old: payload.old,
            });
          }
        );
    },
    [listId]
  );

  // The one place a channel is created. A channel of this client is reused, whether the
  // client effect or a resubscribe asked first. One of an older client is only forgotten:
  // TelegramProvider closed that client with all its channels when it replaced it.
  const subscribe = useCallback(
    (client: SupabaseClient): Subscription => {
      const current = subRef.current;
      if (current?.client === client) return current;

      subscribeCountRef.current++;
      const channelName = `list:${listId}:${subscribeCountRef.current}`;
      const sub: Subscription = { client, channel: createChannel(client, channelName), joined: false, waiters: [] };
      subRef.current = sub;

      sub.channel.subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[RealtimeList] Subscribe failed:", status, "listId:", listId, err);
        }
        if (subRef.current !== sub) return; // removed or forgotten
        if (status === "SUBSCRIBED") {
          sub.joined = true;
          for (const w of sub.waiters.splice(0)) w.resolve();
        } else if (status === "CLOSED") {
          // Closed for good: the next rejoin starts a new channel.
          subRef.current = null;
          for (const w of sub.waiters.splice(0)) w.reject(new Error(`Channel subscribe failed: ${status}`));
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          sub.joined = false;
          // supabase-js rejoins by itself. A reconnect waiting on the join removes the channel
          // instead, so its retry starts a new one.
          if (sub.waiters.length > 0) {
            subRef.current = null;
            removeChannelLogged(client, sub.channel, { listId, reason: `resubscribe ${status}` });
            for (const w of sub.waiters.splice(0)) w.reject(new Error(`Channel subscribe failed: ${status}`));
          }
        }
      });
      return sub;
    },
    [listId, createChannel]
  );

  // Orchestrator step 3: rejoin only when the list's channel is not joined. Resolves once it
  // is; rejects when the join fails or takes longer than RESUBSCRIBE_TIMEOUT_MS.
  const resubscribe = useCallback((): Promise<void> => {
    const client = supabaseClientRef.current;
    if (!client || !listId) return Promise.resolve(); // No client — no-op
    const sub = subscribe(client);
    if (sub.joined) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (subRef.current === sub && !sub.joined) {
          subRef.current = null;
          removeChannelLogged(client, sub.channel, { listId, reason: "resubscribe timed out" });
        }
        for (const w of sub.waiters.splice(0)) w.reject(new Error("Resubscribe timed out"));
      }, RESUBSCRIBE_TIMEOUT_MS);
      sub.waiters.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }, [listId, supabaseClientRef, subscribe]);

  // The list's channel on the current client (created here, or by a resubscribe that ran first)
  useEffect(() => {
    if (!supabaseClient || !listId) return;
    subscribe(supabaseClient);

    return () => {
      const sub = subRef.current;
      // Only this client's channel: one on a newer client belongs to the next run.
      if (sub?.client !== supabaseClient) return;
      subRef.current = null;
      removeChannelLogged(supabaseClient, sub.channel, { listId, reason: "cleanup" });
      for (const w of sub.waiters.splice(0)) w.reject(new Error("Channel removed"));
    };
  }, [supabaseClient, listId, subscribe]);

  return { resubscribe };
}
```

- [ ] **Step 5: Run green.**

```bash
npx vitest run __tests__/unit/realtime-cleanup.test.ts __tests__/unit/realtime-subscribe-logging.test.ts __tests__/unit/category-realtime-wiring.test.ts
npx vitest run
npx tsc --noEmit
npx eslint src/hooks/useRealtimeList.ts __tests__/unit/realtime-cleanup.test.ts __tests__/unit/realtime-subscribe-logging.test.ts
```
  Expected: 17 + 4 + 3 pass, the full suite is green, and tsc and eslint print nothing.

- [ ] **Step 6: Make it bite.** Make each edit, run the two files, see the named test go red, then restore:

| Edit in `useRealtimeList.ts` | Goes red |
|---|---|
| delete `if (current?.client === client) return current;` | "a second run of the effect on the same client keeps its channel", "a rejoin that runs before the client effect shares its channel" |
| delete `if (sub.joined) return Promise.resolve();` | "a rejoin while the channel is joined creates nothing and resolves at once" (times out) |
| cleanup: `if (sub?.client !== supabaseClient) return;` → `if (!sub) return;` | "after a new client, only its one channel is live, and unmount removes it" |
| `CLOSED` branch: delete `subRef.current = null;` | "a channel closed for good is replaced by the next rejoin" |
| `if (sub.waiters.length > 0) {` → `if (false) {` | "logs a failed removal of a channel whose resubscribe errored", "a failed join a rejoin waited on is warned with its error" |
| delete the `console.warn("[RealtimeList] Subscribe failed:", …)` line | the three warn tests in `realtime-subscribe-logging.test.ts` |

- [ ] **Step 7: Commit.**

```bash
git add src/hooks/useRealtimeList.ts __tests__/unit/realtime-cleanup.test.ts __tests__/unit/realtime-subscribe-logging.test.ts
git commit -m "$(cat <<'EOF'
fix(realtime): keep one channel per list across reconnects

The client effect and the orchestrator's resubscribe each created a channel,
and unmount removed only one, so a reconnect could leave two live channels
(H23). subscribe(client) is now the only place a channel is made: it reuses
the list's channel on the same client, resubscribe resolves at once while it
is joined and otherwise waits for the join, and cleanup removes only its own
client's channel.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 1d: Screens wait for the session, then load or show their error with the banner

**Files:**
- Modify: `src/hooks/useListData.ts`, `app/(app)/list/[id]/page.tsx`, `app/(app)/page.tsx`
- Test (create): `__tests__/unit/list-page-session.test.ts`
- Test (modify): `__tests__/unit/home-fetch-lists.test.ts`

**Interfaces:**
- Consumes: `useTelegram().isReady` with the 1b meaning (settled: a JWT, or the sign-in gave up). The pages' first-load effects stay `[isReady, fetchItems]` / `[isReady, fetchLists]`. `isReady` now includes the JWT, so a JWT arriving after a give-up flips it back to true and reloads the page.
- Produces: `fetchItems()` (`useListData`) and `fetchLists()` (home) with no JWT set `error=true` and `loading=false` (home: `error` only when not silent) and warn `"[List] Load skipped, no session:", { listId }` / `"[Home] Load lists skipped, no session:", { view, silent }`. The skeleton and error branches of both screens render `<OfflineIndicator />`.

- [ ] **Step 1: Write the failing list page test.** Create `__tests__/unit/list-page-session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real list page, with the real useListData, as a plain function with slot-based
// stand-ins for React's hooks: state persists across renders, callbacks, memos and effects
// follow their deps, and effects run after the render that queued them. The session comes
// from a stubbed useTelegram the test changes between renders; the other hooks and the
// children are stubbed.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
      return [slot.value, set];
    },
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn(), deps };
      return R.slots[i].value;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      R.effects.push(() => {
        if (typeof s?.cleanup === "function") s.cleanup();
        R.slots[i].cleanup = fn();
      });
    },
  };
});

// Stable across renders, like the real provider's values.
const T = vi.hoisted(() => ({
  isReady: false,
  jwtRef: { current: null as string | null },
  t: (key: string) => key,
  router: { push: () => {} },
  params: { id: "L" },
  refs: { flush: { current: null }, resubscribe: { current: null }, refresh: { current: null } },
  queue: { addMutation: () => {}, flushQueue: async () => {} },
  realtime: { resubscribe: async () => {} },
  drag: { handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } },
}));
vi.mock("next-intl", () => ({ useTranslations: () => T.t, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => T.router, useParams: () => T.params }));
vi.mock("@/components/TelegramProvider", () => ({
  useTelegram: () => ({
    isReady: T.isReady,
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwtRef: T.jwtRef,
    onFlushNeededRef: T.refs.flush,
    onResubscribeNeededRef: T.refs.resubscribe,
    onRefreshNeededRef: T.refs.refresh,
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({ useMutationQueue: () => T.queue }));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => T.realtime }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({ useListDragDrop: () => T.drag }));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: function OfflineIndicator() { return null; } }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: function ListHeader() { return null; } }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";
import OfflineIndicator from "@/components/OfflineIndicator";
import ListHeader from "@/components/list/ListHeader";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

const render = (): El => {
  R.i = 0;
  R.effects = [];
  const tree = (ListPage as () => El)();
  for (const run of R.effects) run();
  return tree;
};
// Renders (running effects), lets the page's requests finish, and renders the result.
const settle = async (): Promise<El> => {
  render();
  for (let k = 0; k < 30; k++) await Promise.resolve();
  return render();
};
function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}
const has = (tree: El, type: unknown) => find(tree, (el) => el.type === type) !== undefined;
const hasText = (tree: El, text: string) => find(tree, (el) => el.props.children === text) !== undefined;
const skeleton = (tree: El) => find(tree, (el) => String(el.props.className).includes("skeleton-shimmer")) !== undefined;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  R.slots = [];
  T.isReady = false;
  T.jwtRef.current = null;
  fetchMock = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type: "regular" }]);
    if (url.startsWith("/api/lists/L/items")) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list page while the session signs in (H10)", () => {
  it("keeps its placeholders, with the connection banner, until the session settles", async () => {
    const tree = await settle();
    expect(skeleton(tree)).toBe(true);
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a JWT once the sign-in gave up, leaves the placeholders for the error screen and its banner", async () => {
    await settle();
    T.isReady = true;
    const tree = await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skeleton(tree)).toBe(false);
    expect(hasText(tree, "lists.loadError")).toBe(true);
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[List] Load skipped, no session:", { listId: "L" });
  });

  it("loads the list when a later retry brings a JWT", async () => {
    T.isReady = true;
    await settle(); // gave up: the error screen
    T.isReady = false; // the manual retry restarts the sign-in
    await settle();
    T.jwtRef.current = "jwt";
    T.isReady = true;

    const tree = await settle();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/lists", "/api/lists/L/items?limit=500"]);
    expect(has(tree, ListHeader)).toBe(true);
    expect(hasText(tree, "lists.loadError")).toBe(false);
  });
});
```

- [ ] **Step 2: Add the failing home tests to `__tests__/unit/home-fetch-lists.test.ts`.**
  Replace:
```ts
import HomePage from "@/app/(app)/page";
```
  with:
```ts
import HomePage from "@/app/(app)/page";
import OfflineIndicator from "@/components/OfflineIndicator";
```
  Replace:
```ts
const reply = (status: number, body: unknown = { error: "Server error" }) => ({ ok: status < 400, status, json: async () => body });
```
  with:
```ts
// Whether the tree renders an element of this component.
const has = (node: unknown, type: unknown): boolean =>
  Array.isArray(node)
    ? node.some((n) => has(n, type))
    : !!node && typeof node === "object" && "props" in node &&
      ((node as El).type === type || has((node as El).props.children, type));

const reply = (status: number, body: unknown = { error: "Server error" }) => ({ ok: status < 400, status, json: async () => body });
```
  Append at the end of the file:
```ts
describe("home without a session (H10)", () => {
  afterEach(() => {
    T.jwtRef.current = "jwt";
  });

  it("the placeholders show the connection banner", () => {
    expect(has(render(), OfflineIndicator)).toBe(true);
  });

  it("without a JWT, leaves the placeholders for the error screen and its banner", async () => {
    T.jwtRef.current = null;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await fetchLists()();
    const tree = render();
    expect(f).not.toHaveBeenCalled();
    expect(text(tree)).toContain("lists.loadError");
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists skipped, no session:", { view: "active", silent: false });
  });
});
```

- [ ] **Step 3: Run them, expect failures.**
  Run: `npx vitest run __tests__/unit/list-page-session.test.ts __tests__/unit/home-fetch-lists.test.ts`
  Expected: 4 failed.
  - Both "placeholders show the connection banner" tests: `expected false to be true`, because there is no `OfflineIndicator` in the skeleton.
  - The list no-JWT test: `skeleton` stays true, because `loading` is never cleared.
  - The home no-JWT test: `expected '  ' to contain 'lists.loadError'`.

  "loads the list when a later retry brings a JWT" passes today. It guards the `[isReady, …]` dependency (Step 6).

- [ ] **Step 4: Implement.**

  `src/hooks/useListData.ts`. Replace:
```ts
  const fetchItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
```
  with:
```ts
  const fetchItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) {
      // The session gave up signing in: leave the placeholders for the error screen, where
      // the connection banner says why. A later token loads the list (the page reruns this).
      console.warn("[List] Load skipped, no session:", { listId });
      setError(true);
      setLoading(false);
      return;
    }
    try {
```

  `app/(app)/list/[id]/page.tsx`. Replace:
```tsx
  useEffect(() => {
    if (isReady) fetchItems();
  }, [isReady, fetchItems]);
```
  with:
```tsx
  // isReady turns true once the session settled: with a JWT the list loads; without one
  // (the sign-in gave up) fetchItems shows the error screen, and a later token reloads it.
  useEffect(() => {
    if (isReady) fetchItems();
  }, [isReady, fetchItems]);
```
  Replace:
```tsx
  if (loading) {
    return (
      <div className="px-5 pt-3 space-y-3">
        <div className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4">
        <p className="text-tg-hint mb-4">{t('lists.loadError')}</p>
        <button
          onClick={fetchItems}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.retry')}
        </button>
      </div>
    );
  }
```
  with:
```tsx
  // The connection banner shows over the placeholders and the error screen too, so a
  // session that is still signing in (or gave up) says so.
  if (loading) {
    return (
      <>
        <OfflineIndicator />
        <div className="px-5 pt-3 space-y-3">
          <div className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer" />
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-14 bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
            />
          ))}
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <OfflineIndicator />
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
          <p className="text-tg-hint mb-4">{t('lists.loadError')}</p>
          <button
            onClick={fetchItems}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry')}
          </button>
        </div>
      </>
    );
  }
```

  `app/(app)/page.tsx`. Replace:
```tsx
  const fetchLists = useCallback(async ({ silent = false } = {}) => {
    const jwt = jwtRef.current;
    if (!jwt) return;
```
  with:
```tsx
  const fetchLists = useCallback(async ({ silent = false } = {}) => {
    const jwt = jwtRef.current;
    if (!jwt) {
      // The session gave up signing in: leave the placeholders for the error screen, where
      // the connection banner says why. A later token reruns this (isReady below).
      console.warn("[Home] Load lists skipped, no session:", { view, silent });
      if (!silent) setError(true);
      setLoading(false);
      return;
    }
```
  Replace:
```tsx
  useEffect(() => {
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);
```
  with:
```tsx
  // isReady turns true once the session settled, with or without a JWT.
  useEffect(() => {
    if (isReady) fetchLists();
  }, [isReady, fetchLists]);
```
  Replace:
```tsx
  if (loading) {
    return (
      <div className="px-5 pt-3 space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[72px] bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4">
        <p className="text-tg-hint mb-4">{t('lists.loadError')}</p>
        <button
          onClick={() => fetchLists()}
          className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.retry')}
        </button>
      </div>
    );
  }
```
  with:
```tsx
  // The connection banner shows over the placeholders and the error screen too, so a
  // session that is still signing in (or gave up) says so.
  if (loading) {
    return (
      <>
        <OfflineIndicator />
        <div className="px-5 pt-3 space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[72px] bg-tg-secondary-bg rounded-2xl skeleton-shimmer"
            />
          ))}
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <OfflineIndicator />
        <div className="flex flex-col items-center justify-center min-h-screen p-4">
          <p className="text-tg-hint mb-4">{t('lists.loadError')}</p>
          <button
            onClick={() => fetchLists()}
            className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry')}
          </button>
        </div>
      </>
    );
  }
```

- [ ] **Step 5: Run green.**

```bash
npx vitest run __tests__/unit/list-page-session.test.ts __tests__/unit/home-fetch-lists.test.ts
npx vitest run
npx tsc --noEmit
npx eslint "app/(app)/page.tsx" "app/(app)/list/[id]/page.tsx" src/hooks/useListData.ts __tests__/unit/list-page-session.test.ts __tests__/unit/home-fetch-lists.test.ts
```
  Expected: 3 + 5 pass, the full suite is green (`list-data-categories`, `home-background-saves`, `list-type-switch`, `grouped-list-wiring` unchanged), and tsc and eslint print nothing.

- [ ] **Step 6: Make it bite.** Make each edit, run the two files, see the named test go red, then restore:

| Edit | Goes red |
|---|---|
| `useListData.ts`: in the no-JWT branch delete `setError(true);` and `setLoading(false);` | "without a JWT once the sign-in gave up, leaves the placeholders for the error screen and its banner" |
| list page: delete `<OfflineIndicator />` from the `loading` branch | "keeps its placeholders, with the connection banner, until the session settles" |
| list page: delete `<OfflineIndicator />` from the `error` branch | "without a JWT once the sign-in gave up…" |
| list page: first-load effect deps `[isReady, fetchItems]` → `[]` (add `// eslint-disable-line` for the run) | "loads the list when a later retry brings a JWT" |
| home: in the no-JWT branch delete `if (!silent) setError(true);` and `setLoading(false);` | "without a JWT, leaves the placeholders for the error screen and its banner" |
| home: delete `<OfflineIndicator />` from the `loading` branch | "the placeholders show the connection banner" |
| home: delete `<OfflineIndicator />` from the `error` branch | "without a JWT, leaves the placeholders…" |

- [ ] **Step 7: Final gate for Task 1.**

```bash
npx next typegen
npx vitest run && npx tsc --noEmit && npx eslint "app/(app)" components/TelegramProvider.tsx src/hooks/useJWTRefresh.ts src/hooks/useReconnectOrchestrator.ts src/hooks/useRealtimeList.ts src/hooks/useListData.ts __tests__/unit
```
  Expected: the whole suite is green (918 tests in the dry run), and tsc and eslint print nothing. Never `npm run build`, because it migrates prod. The controller runs `npx next build` at the branch gate.

- [ ] **Step 8: Commit.**

```bash
git add src/hooks/useListData.ts "app/(app)/list/[id]/page.tsx" "app/(app)/page.tsx" __tests__/unit/list-page-session.test.ts __tests__/unit/home-fetch-lists.test.ts
git commit -m "$(cat <<'EOF'
fix(screens): wait for the session, then load or show the error with the banner

With no JWT, the list and home loads returned before clearing `loading`, so a
failed sign-in left grey placeholders forever, and the connection banner was
not rendered there (H10). The loads now leave the placeholders for the error
screen, both screens show OfflineIndicator over the placeholders and the
error, and a later token reloads them through isReady.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

- [ ] **Step 9: Clean up.** Leave nothing in the repo: no stray scratch files, and `git status` shows a clean tree. The regenerated `.next/types` is gitignored.

### Task 2: Server: idempotent recycle, scoped bulk routes, tap time, aligned counts

Four small sub-tasks, each green and committed on its own. Server only: no client file changes here. T3 makes the client send `at`; T5 makes Clear completed and Unmark all send `itemIds`.

**What T1 changed before this task:** nothing in these files. T1 touches `components/TelegramProvider.tsx`, `src/hooks/useJWTRefresh.ts`, the page files (moved into `app/(app)/`) and their tests. Every file below is unchanged from `main` at 2934605 when T2 starts. Anchor on the snippets, not on line numbers.

**Interfaces produced (all of T2):**

```ts
// src/services/item-recycler.ts (signature change: a 4th, required argument)
export async function recycleItem(itemId: string, userId: string, listId: string, text: string): Promise<RecyclableItem | null>;
// Acts only on a live row of listId (deleted_at null) whose normalized text equals the normalized `text`.
//   completed      -> recycled (completed=false, completed_at/skipped_at/ordered_at null, position MAX+1, created_by=userId), row returned
//   already active -> returned unchanged, no write (logs console.warn "[ItemRecycler] Item already active, returning it unchanged:")
//   anything else  -> null, no write. A DB error is logged and thrown.

// POST /api/lists/[id]/items, batch path: when recycleId is set, recycleItem(recycleId, auth.userId, listId, text) decides.
//   Non-null -> pushed as { ...row, recycled: true }, nothing inserted. The response stays 201 { items: [...] }.

// src/schemas/items.ts
export const unskipAllSchema;        // unchanged shape: z.object({ itemIds: z.array(z.string().uuid()).min(1).max(500) })
export const clearCompletedSchema;   // same shape (one shared definition)
export const unmarkCompletedSchema;  // same shape (one shared definition)
// updateItemSchema gains: at: z.iso.datetime({ offset: true }).optional()

// POST /api/lists/[id]/items/clear-completed  body { itemIds: string[] } -> 200 { cleared: number, clearedIds: string[] }; bad body -> 400, no write
// POST /api/lists/[id]/items/unmark-completed body { itemIds: string[] } -> 200 { unmarked: number, unmarkedIds: string[] }; bad body -> 400, no write
// PATCH /api/lists/[id]/items  optional `at`: completed_at / skipped_at / ordered_at = clamp(at, now-24h, now); no `at` -> now; a non-ISO `at` -> 400

// supabase/migrations/030_list_item_counts_match_list.sql
// get_list_item_counts(p_list_ids UUID[]) RETURNS TABLE (list_id UUID, active_count BIGINT, completed_count BIGINT)
//   active_count    = completed = false AND skipped_at IS NULL
//   completed_count = completed = true AND recurring = false
```

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H8 | `app/api/lists/[id]/items/route.ts:265-290`: the recycle target must be in `findRecyclableItems` (completed-only, `src/services/item-recycler.ts:36-44`). After the first delivery the row is active, `pickRecyclable` misses and the loop inserts at `route.ts:292-316`. | `recycleItem` takes the expected `text`, looks the id up among this list's live rows, and returns an already-active same-text row unchanged. The route hands `recycleId` straight to it. `findRecyclableItems`/`pickRecyclable` leave the POST, and `src/utils/pick-recyclable.ts` is deleted. Voice passes the matched row's text. | `__tests__/unit/recycle-replay.test.ts` "a replay of the same recycle returns the item unchanged with 201 and writes nothing", "a second device recycling ..."; `__tests__/unit/item-recycler.test.ts` "returns an item that is already active unchanged ..." |
| H11 (server) | `app/api/lists/[id]/items/clear-completed/route.ts:31-38` and `unmark-completed/route.ts:26-32` update every completed row of the list. They take no body. | Both parse `{ itemIds }` (shared schema, the one unskip-all already uses) and add `.in("id", itemIds)` to their current filters. | `__tests__/unit/clear-completed-route.test.ts` "soft-deletes only the shown completed items ..."; `__tests__/unit/unmark-completed-route.test.ts` "flips only the shown completed items back ..." |
| H19 (server) | `app/api/lists/[id]/items/route.ts:376-381, 395-403` stamp `new Date()` at delivery. The body carries no action time, and zod strips unknown keys. | `updateItemSchema.at` is an optional ISO date-time. `tapTime(at)` clamps it to [now-24h, now] and feeds completed_at / skipped_at / ordered_at. | `__tests__/unit/items-patch-tap-time.test.ts` (each of tick / skip / on the way: tap time kept, clamped both ways, no-`at` fallback, duplicate delivery) |
| Decision 4 | `supabase/migrations/008_security_fixes.sql:52-65` counts `completed = false` (skipped included) and `completed = true` (parked recurring included). | Migration 030 redefines the function with the list's own predicates. | `__tests__/unit/migration-030-list-item-counts.test.ts` evaluates the two FILTER predicates against `isActiveItem` / `isParkedRecurringItem` over every state combination |

---

### Task 2a: A repeated recycle lands once (H8)

**Files:**
- Create: `__tests__/helpers/fake-items-table.ts`, `__tests__/unit/recycle-replay.test.ts`
- Modify: `src/services/item-recycler.ts`, `app/api/lists/[id]/items/route.ts` (POST batch loop and imports only), `src/services/voice-handler.ts`
- Delete: `src/utils/pick-recyclable.ts`, `__tests__/unit/pick-recyclable.test.ts` (the helper has no caller left. Its guarantee, that a client-supplied id can't reach another list's row, a deleted row or a row with other text, now lives in `recycleItem` and is proven by `recycle-replay.test.ts` and `item-recycler.test.ts`.)
- Test (update to the new contract): `__tests__/unit/item-recycler.test.ts`, `__tests__/unit/items-post-recycle-failure.test.ts`, `__tests__/unit/items-route-db-errors.test.ts` (recycler mock only), `__tests__/unit/recycle-scoping.test.ts`, `__tests__/unit/voice-handler-failures.test.ts`

**Interfaces:** Produces `recycleItem(itemId: string, userId: string, listId: string, text: string): Promise<RecyclableItem | null>` (see above). Consumes nothing new. The POST response shape is unchanged (`201 { items: [{ ...row, recycled: true }] }`), which is what T3's recycle executor resolves with.

- [ ] **Step 1: Write the stateful table helper.** Create `__tests__/helpers/fake-items-table.ts`:

```ts
// A stateful items table behind the fakeSupabase builder. Reads and updates apply their
// filters to the rows, and the insert RPC adds a row, so a route test can assert what the
// database holds afterwards instead of which query text was sent.
import { fakeSupabase, type FakeCall, type FakeResult } from "./fake-supabase";

export type ItemRow = {
  id: string;
  list_id: string;
  text: string;
  completed: boolean;
  completed_at: string | null;
  deleted_at: string | null;
  skipped_at: string | null;
  ordered_at: string | null;
  recurring: boolean;
  position: number;
  created_by: string | null;
};

export function itemRow(over: Partial<ItemRow> & { id: string }): ItemRow {
  return {
    list_id: "L",
    text: "x",
    completed: false,
    completed_at: null,
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    position: 1,
    created_by: null,
    ...over,
  };
}

const SHAPE = /^(select:|order:|limit:|single$|maybeSingle$)/;

const escapeRegExp = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Postgres ILIKE: % is any run, _ is one character, a backslash escapes either.
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += escapeRegExp(pattern[++i]);
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, "is").test(value);
}

function matches(row: ItemRow, filter: string): boolean {
  const cell = (k: string) => (row as Record<string, unknown>)[k];
  let m: RegExpMatchArray | null;
  if ((m = filter.match(/^eq:([^=]+)=(.*)$/))) return String(cell(m[1])) === m[2];
  if ((m = filter.match(/^is:([^=]+)=null$/))) return cell(m[1]) == null;
  if ((m = filter.match(/^in:([^=]+)=(.*)$/))) return m[2].split(",").includes(String(cell(m[1])));
  if ((m = filter.match(/^not:([^:]+):is:null$/))) return cell(m[1]) != null;
  if ((m = filter.match(/^ilike:([^=]+)=(.*)$/))) return ilike(String(cell(m[1])), m[2]);
  if (SHAPE.test(filter)) return true;
  // An unknown filter must fail the test loudly, never match everything by accident.
  throw new Error(`fake-items-table: unsupported filter ${filter}`);
}

function shape(call: FakeCall, rows: ItemRow[]): FakeResult {
  let out = rows.map((r) => ({ ...r }));
  const order = call.filters.find((f) => f.startsWith("order:"));
  if (order) {
    const [, col, asc] = order.split(":");
    const v = (r: ItemRow) => {
      const x = (r as Record<string, unknown>)[col];
      return typeof x === "number" ? x : x == null ? -Infinity : Date.parse(String(x));
    };
    out.sort((a, b) => (asc === "true" ? v(a) - v(b) : v(b) - v(a)));
  }
  const limit = call.filters.find((f) => f.startsWith("limit:"));
  if (limit) out = out.slice(0, Number(limit.slice("limit:".length)));
  if (call.filters.includes("maybeSingle")) return { data: out[0] ?? null, error: null };
  if (call.filters.includes("single")) {
    return out.length === 1
      ? { data: out[0], error: null }
      : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }
  return { data: out, error: null };
}

export function fakeItemsTable(initial: ItemRow[]) {
  const rows = initial.map((r) => ({ ...r }));
  let created = 0;
  const fake = fakeSupabase((call: FakeCall): FakeResult => {
    if (call.op === "rpc" && call.table === "insert_item_if_under_limit") {
      const v = call.values as { p_list_id: string; p_text: string; p_position: number; p_created_by: string };
      const row = itemRow({ id: `new-${++created}`, list_id: v.p_list_id, text: v.p_text, position: v.p_position, created_by: v.p_created_by });
      rows.push(row);
      return { data: [{ ...row }], error: null };
    }
    if (call.table !== "items") return { data: null, error: null };
    const hit = rows.filter((r) => call.filters.every((f) => matches(r, f)));
    if (call.op === "select") return shape(call, hit);
    if (call.op === "update") {
      for (const r of hit) Object.assign(r, call.values as Partial<ItemRow>);
      return call.filters.some((f) => f.startsWith("select:")) ? shape(call, hit) : { data: null, error: null };
    }
    throw new Error(`fake-items-table: unsupported ${call.op} on items`);
  });
  return { client: fake.client, calls: fake.calls, rows };
}
```

- [ ] **Step 2: Write the failing route test (the audit's repro: the same recycle POSTed twice, and two devices).** Create `__tests__/unit/recycle-replay.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items POST and the real recycler over an in-memory items table; auth, the
// rate limiter and the categorizer are faked. H8: a recycle (re-add from suggestions) that
// is delivered twice, by a queue replay after a lost response or by two devices tapping the
// same suggestion, must leave exactly one active row.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { table: string; op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

import { POST } from "@/app/api/lists/[id]/items/route";

const OLD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const params = { params: Promise.resolve({ id: "L" }) };
const recycle = (body: unknown = { text: "milk", recycleId: OLD }) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const completedMilk = (over: Partial<ItemRow> = {}) =>
  itemRow({ id: OLD, text: "milk", completed: true, completed_at: "2026-10-01T00:00:00.000Z", position: 2, created_by: "u0", ...over });
const live = () => h.db.rows.filter((r) => r.list_id === "L" && !r.deleted_at);
const inserts = () => h.db.calls.filter((c) => c.op === "rpc");
const writes = () => h.db.calls.filter((c) => c.op === "update");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST items: a repeated recycle lands once", () => {
  it("the first delivery recycles the completed item to the top", async () => {
    h.db = fakeItemsTable([completedMilk(), itemRow({ id: "eggs", text: "eggs", position: 5 })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, completed: false, recycled: true })]);
    expect(live().find((r) => r.id === OLD)).toMatchObject({ completed: false, completed_at: null, position: 6, created_by: "u1" });
    expect(inserts()).toEqual([]);
  });

  it("a replay of the same recycle returns the item unchanged with 201 and writes nothing", async () => {
    h.db = fakeItemsTable([completedMilk(), itemRow({ id: "eggs", text: "eggs", position: 5 })]);
    expect((await recycle()).status).toBe(201);
    const afterFirst = JSON.stringify(h.db.rows);
    const writesAfterFirst = writes().length;

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, text: "milk", recycled: true })]);
    expect(live().filter((r) => r.text === "milk")).toHaveLength(1);
    expect(inserts()).toEqual([]);
    expect(writes()).toHaveLength(writesAfterFirst);
    expect(JSON.stringify(h.db.rows)).toBe(afterFirst);
  });

  it("a second device recycling an item another device already brought back gets that item, not a copy", async () => {
    // Device A's recycle already landed: the row is active again at the top.
    h.db = fakeItemsTable([completedMilk({ completed: false, completed_at: null, position: 9, created_by: "uA" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ position: 9, created_by: "uA" });
  });

  it("an active item whose text was changed meanwhile is not reused: the text is added as a new item", async () => {
    h.db = fakeItemsTable([completedMilk({ text: "oat milk", completed: false, completed_at: null })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ text: "milk", recycled: false })]);
    expect(live().map((r) => r.text).sort()).toEqual(["milk", "oat milk"]);
    expect(writes()).toEqual([]);
  });

  it("a deleted item stays deleted: the text is added as a new item", async () => {
    h.db = fakeItemsTable([completedMilk({ deleted_at: "2026-10-20T00:00:00.000Z" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect(h.db.rows.find((r) => r.id === OLD)).toMatchObject({ deleted_at: "2026-10-20T00:00:00.000Z", completed: true });
    expect(live().map((r) => r.text)).toEqual(["milk"]);
    expect(live()[0].id).not.toBe(OLD);
  });

  it("an id from another list is never touched, even when that item is active with the same text", async () => {
    h.db = fakeItemsTable([completedMilk({ list_id: "OTHER", completed: false, completed_at: null })]);
    const other = { ...h.db.rows[0] };

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ text: "milk", recycled: false })]);
    expect(h.db.rows[0]).toEqual(other);
    expect(live().map((r) => r.text)).toEqual(["milk"]);
  });

  it("a completed item with different text is not recycled under the request's text", async () => {
    h.db = fakeItemsTable([completedMilk({ text: "eggs" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect(h.db.rows.find((r) => r.id === OLD)).toMatchObject({ completed: true, text: "eggs" });
    expect(live().filter((r) => !r.completed).map((r) => r.text)).toEqual(["milk"]);
  });
});
```

- [ ] **Step 3: Replace the `recycleItem` tests with the new contract.** In `__tests__/unit/item-recycler.test.ts`, first change the lookup discriminator inside `use()`. The new lookup selects the row's columns, not `list_id`.

Current:
```ts
    if (c.cols === "list_id") return pick(w.lookup, null);
```
Replacement:
```ts
    if (c.filters.some((f) => f.startsWith("eq:id="))) return pick(w.lookup, null);
```

Then replace the whole `describe("recycleItem", () => { ... });` block, from `describe("recycleItem", () => {` to the end of the file, with:

```ts
describe("recycleItem", () => {
  const lookups = () => h.fake.calls.filter((c) => c.op === "select" && c.filters.some((f) => f.startsWith("eq:id=")));

  it("moves a completed item to the top and returns it", async () => {
    use({
      lookup: ok(milk),
      maxPos: ok([{ position: 7 }]),
      update: ok({ ...milk, completed: false, completed_at: null, position: 8 }),
    });
    expect(await recycleItem("i1", "u1", "L", "milk")).toMatchObject({ id: "i1", position: 8 });
    expect(updates()[0].values).toMatchObject({ completed: false, position: 8, created_by: "u1" });
    expect(updates()[0].filters).toEqual(expect.arrayContaining(["eq:id=i1", "eq:list_id=L"]));
  });

  it("looks the id up among this list's live rows only (another list's id, or a deleted item, is never written)", async () => {
    use({ lookup: ok(null) });
    expect(await recycleItem("i1", "u1", "L", "milk")).toBeNull();
    expect(lookups()[0].filters).toEqual(expect.arrayContaining(["eq:id=i1", "eq:list_id=L", "is:deleted_at=null"]));
    expect(updates()).toEqual([]);
  });

  it("returns an item that is already active unchanged and writes nothing (a replay lands once)", async () => {
    const active = { ...milk, completed: false, completed_at: null, position: 9 };
    use({ lookup: ok(active), maxPos: ok([{ position: 9 }]), update: ok(active) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await recycleItem("i1", "u1", "L", "Milk")).toEqual(active);
    expect(updates()).toEqual([]);
    expect(h.fake.calls.filter((c) => c.cols === "position")).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("[ItemRecycler] Item already active, returning it unchanged:", { listId: "L", itemId: "i1" });
  });

  it.each([
    ["a completed", milk],
    ["an already active", { ...milk, completed: false, completed_at: null }],
  ])("returns null and writes nothing for %s item whose text is not the expected one", async (_label, row) => {
    use({ lookup: ok({ ...row, text: "oat milk" }), maxPos: ok([{ position: 7 }]), update: ok(row) });
    expect(await recycleItem("i1", "u1", "L", "milk")).toBeNull();
    expect(updates()).toEqual([]);
  });

  it("returns null, without logging, for an item that is not in this list", async () => {
    use({ lookup: ok(null) });
    expect(await recycleItem("i1", "u1", "L", "milk")).toBeNull();
    expect(updates()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects and logs when the lookup fails, and writes nothing", async () => {
    use({ lookup: err() });
    await expect(recycleItem("i1", "u1", "L", "milk")).rejects.toThrow("Recycle item lookup failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Item lookup failed:", { listId: "L", itemId: "i1" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects when the max-position read fails, instead of recycling to position 1", async () => {
    use({ lookup: ok(milk), maxPos: err() });
    await expect(recycleItem("i1", "u1", "L", "milk")).rejects.toThrow("Max position read failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Max position read failed:", { listId: "L" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects and logs when the update fails", async () => {
    use({ lookup: ok(milk), maxPos: ok([{ position: 7 }]), update: err() });
    await expect(recycleItem("i1", "u1", "L", "milk")).rejects.toThrow("Recycle update failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Recycle update failed:", { listId: "L", itemId: "i1" }, dbErr);
  });

  it("returns null, without logging, when the row is gone by the time of the update", async () => {
    use({ lookup: ok(milk), maxPos: ok([{ position: 7 }]), update: ok(null) });
    expect(await recycleItem("i1", "u1", "L", "milk")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
```

(Each old test is kept with its intent; the lookup fixture becomes the full row (`milk`) instead of `{ list_id: "L" }`, and every call passes the text.)

- [ ] **Step 4: Run the new tests and watch them fail.**

Run: `npx vitest run __tests__/unit/recycle-replay.test.ts __tests__/unit/item-recycler.test.ts`
Expected:
- `recycle-replay.test.ts`: 2 failed, the replay test and the second-device test. Each response has `id: "new-1", recycled: false`, so the route inserted a second "milk". The other 5 pass already; they guard the rules the fix must keep.
- `item-recycler.test.ts`: 4 failed. These are "looks the id up among this list's live rows only" (no `is:deleted_at=null` filter), "returns an item that is already active unchanged" (an update ran), and both "returns null ... whose text is not the expected one" cases.

- [ ] **Step 5: Implement `recycleItem`.** In `src/services/item-recycler.ts`:

Current:
```ts
import { normalizeForStorage } from "@/src/utils/text-normalize";
```
Replacement:
```ts
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
```

Replace everything from the line `/**` that starts ` * Recycle an item — restore it to active state.` up to (not including) the `/**` before ` * Find fuzzy matches for voice processing.`, so the whole old JSDoc and `recycleItem` function. Current:
```ts
/**
 * Recycle an item — restore it to active state.
 * Sets completed=false, completed_at=null, deleted_at=null,
 * and position to MAX(position)+1 (top of list).
 * Returns null only when the item is not (or no longer) in this list. A failed read or
 * write is logged and thrown, so a caller never mistakes it for "nothing to recycle".
 */
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // Get the item's list to find max position. Scoped to listId (defence in depth):
  // callers are expected to have already validated itemId against a list-scoped
  // lookup (see pickRecyclable), but this guard means a cross-list id can never
  // reach the update below even if that validation is skipped or forgotten by a
  // future caller.
  const { data: item, error: lookupError } = await supabase
    .from("items")
    .select("list_id")
    .eq("id", itemId)
    .eq("list_id", listId)
    .maybeSingle();

  if (lookupError) {
    console.error("[ItemRecycler] Item lookup failed:", { listId, itemId }, lookupError);
    throw new Error("Recycle item lookup failed", { cause: lookupError });
  }
  if (!item) return null;

  // Get max position
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", item.list_id)
    .order("position", { ascending: false })
    .limit(1);
```
Replacement:
```ts
const RECYCLE_COLUMNS = "id, text, completed, completed_at, deleted_at, position";

/**
 * Recycle an item — bring it back to the top of the active list.
 * Acts only on a live row of this list that still has the text the caller expects
 * (`text`, compared normalized); anything else answers null and writes nothing.
 * - Completed: sets completed=false, clears completed_at, skipped_at and ordered_at,
 *   and moves it to MAX(position)+1 (top of list).
 * - Already active: returned unchanged. A replayed recycle, or a second device tapping
 *   the same suggestion, lands once instead of adding a second copy.
 * A failed read or write is logged and thrown, so a caller never mistakes it for
 * "nothing to recycle".
 */
export async function recycleItem(
  itemId: string,
  userId: string,
  listId: string,
  text: string
): Promise<RecyclableItem | null> {
  const supabase = createServerClient();

  // The caller may pass a client-supplied id. Scoped to listId, so an id from another
  // list never reaches the update below, and to live rows, so a deleted item stays
  // deleted (deleting is final).
  const { data: item, error: lookupError } = await supabase
    .from("items")
    .select(RECYCLE_COLUMNS)
    .eq("id", itemId)
    .eq("list_id", listId)
    .is("deleted_at", null)
    .maybeSingle();

  if (lookupError) {
    console.error("[ItemRecycler] Item lookup failed:", { listId, itemId }, lookupError);
    throw new Error("Recycle item lookup failed", { cause: lookupError });
  }
  if (!item) return null;
  // The id must name the item the caller means: an id with other text is not reused.
  if (normalizeForCompare(normalizeForStorage(item.text)) !== normalizeForCompare(normalizeForStorage(text))) {
    return null;
  }
  if (!item.completed) {
    console.warn("[ItemRecycler] Item already active, returning it unchanged:", { listId, itemId });
    return item as RecyclableItem;
  }

  // Get max position
  const { data: maxPosResult, error: maxPosError } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);
```

Further down in the same function, current:
```ts
    .eq("id", itemId)
    .eq("list_id", listId)
    .select("id, text, completed, completed_at, deleted_at, position")
    .maybeSingle();
```
Replacement:
```ts
    .eq("id", itemId)
    .eq("list_id", listId)
    .select(RECYCLE_COLUMNS)
    .maybeSingle();
```
(The update's values, the `if (error)` block and the "row went away" `return null` stay as they are.)

- [ ] **Step 6: Make the POST hand the recycleId to `recycleItem`.** In `app/api/lists/[id]/items/route.ts`:

Current:
```ts
import { findRecyclableItems, recycleItem, type RecyclableItem } from "@/src/services/item-recycler";
```
Replacement:
```ts
import { recycleItem, type RecyclableItem } from "@/src/services/item-recycler";
```

Current:
```ts
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
import { pickRecyclable } from "@/src/utils/pick-recyclable";
```
Replacement:
```ts
import { normalizeForStorage } from "@/src/utils/text-normalize";
```

In the batch loop of `POST` (inside `for (const text of itemTexts) {`), current:
```ts
    // Check for recyclable items. The recycler logs and throws on a DB error. Skip the
    // item then, the loop's rule for an insert error, so a failed check never adds a duplicate.
    let recycled: RecyclableItem | null = null;
    try {
      const recyclable = await findRecyclableItems(listId, text);
      const exactMatch = recyclable.find(
        (r) => normalizeForCompare(r.text) === normalizeForCompare(text)
      );

      // Explicit recycle request from UI autocomplete. The client-supplied recycleId is
      // never trusted directly — it must resolve against `recyclable`, the set the server
      // itself just looked up for this list (list-scoped, completed-only). Otherwise a
      // client could pass any uuid and recycleItem would resurrect/re-attribute an
      // arbitrary row in someone else's list.
      const toRecycle = exactMatch && pickRecyclable(recyclable, parsedCreate.data.recycleId);
      if (toRecycle) recycled = await recycleItem(toRecycle.id, auth.userId, listId);
    } catch (err) {
      console.error("[items/POST] Recycle check failed, skipping item (batch):", { listId }, err);
      failures++;
      lastError = err;
      continue;
    }
    if (recycled) {
      results.push({ ...recycled, recycled: true });
      continue;
    }
```
Replacement:
```ts
    // A suggestion tap names the item to recycle. recycleItem checks the client-supplied id
    // itself (this list, not deleted, same text): a completed item comes back to the top, one
    // that is already active (a replay, or another device was first) comes back unchanged, and
    // anything else answers null so the text is added as a new item. It logs and throws on a
    // DB error: skip the item then, the loop's rule for an insert error, so a failed check
    // never adds a duplicate.
    const recycleId = parsedCreate.data.recycleId;
    if (recycleId) {
      let recycled: RecyclableItem | null;
      try {
        recycled = await recycleItem(recycleId, auth.userId, listId, text);
      } catch (err) {
        console.error("[items/POST] Recycle check failed, skipping item (batch):", { listId }, err);
        failures++;
        lastError = err;
        continue;
      }
      if (recycled) {
        results.push({ ...recycled, recycled: true });
        continue;
      }
    }
```
(A typed add without `recycleId` no longer runs any recycle read. Before this change it ran `findRecyclableItems` and discarded the result, because `pickRecyclable(…, undefined)` is always undefined.)

- [ ] **Step 7: Voice passes the matched row's own text.** In `src/services/voice-handler.ts`, in `processAddItem`:

Current:
```ts
      await recycleOrThrow(match.id, userId, listId);
```
Replacement:
```ts
      await recycleOrThrow(match.id, match.text, userId, listId);
```

Current:
```ts
      await recycleOrThrow(bestMatch.id, userId, listId);
```
Replacement:
```ts
      await recycleOrThrow(bestMatch.id, bestMatch.text, userId, listId);
```

Current:
```ts
/**
 * recycleItem throws on a database error and returns null when the row is gone. Either way
 * the item was not recycled, so this throws and the receipt never claims it.
 */
async function recycleOrThrow(itemId: string, userId: string, listId: string): Promise<void> {
  const recycled = await recycleItem(itemId, userId, listId);
```
Replacement:
```ts
/**
 * recycleItem throws on a database error and returns null when the row is gone (or its text
 * changed since the match). Either way the item was not recycled, so this throws and the
 * receipt never claims it. `text` is the matched row's own text, so a fuzzy match still recycles.
 */
async function recycleOrThrow(itemId: string, text: string, userId: string, listId: string): Promise<void> {
  const recycled = await recycleItem(itemId, userId, listId, text);
```

- [ ] **Step 8: Delete the helper that has no caller left.**

```bash
rm src/utils/pick-recyclable.ts __tests__/unit/pick-recyclable.test.ts
```
(Plain `rm`; the deletion is staged by the explicit `git add` in Step 12.)

- [ ] **Step 9: Update the existing tests that encode the old flow.**

`__tests__/unit/items-post-recycle-failure.test.ts` (the route no longer calls `findRecyclableItems`):

Current:
```ts
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  find: vi.fn(),
  recycle: vi.fn(),
```
Replacement:
```ts
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  recycle: vi.fn(),
```

Current:
```ts
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: h.find, recycleItem: h.recycle }));
```
Replacement:
```ts
vi.mock("@/src/services/item-recycler", () => ({ recycleItem: h.recycle }));
```

Current:
```ts
const completedMilk = { id: OLD, text: "milk", completed: true, completed_at: "2026-10-01T00:00:00Z", deleted_at: null, position: 2 };
```
Replacement:
```ts
const recycledMilk = { id: OLD, text: "milk", completed: false, completed_at: null, deleted_at: null, position: 9 };
```

Current (in `beforeEach`):
```ts
  h.find.mockReset().mockResolvedValue([]);
  h.recycle.mockReset().mockResolvedValue(null);
```
Replacement:
```ts
  h.recycle.mockReset().mockResolvedValue(null);
```

Current, the first two tests of the describe:
```ts
  it("skips an item whose recyclable lookup fails, logs it, and still adds the rest", async () => {
    const boom = new Error("Recyclable items read failed");
    h.find.mockImplementation(async (_listId: string, text: string) => {
      if (text === "milk") throw boom;
      return [];
    });
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["eggs"]);
    expect((await res.json()).items.map((i: { text: string }) => i.text)).toEqual(["eggs"]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("skips the item when the recycle itself fails, instead of inserting a new copy", async () => {
    const boom = new Error("Recycle update failed");
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockRejectedValue(boom);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    // Nothing was written and the only item failed: a 500 the queue retries (safe, no duplicate).
    expect(res.status).toBe(500);
    expect(h.recycle).toHaveBeenCalledWith(OLD, "u1", "L");
    expect(inserted()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });
```
Replacement:
```ts
  it("skips an item whose recycle check fails, logs it, and still adds the rest", async () => {
    const boom = new Error("Recycle item lookup failed");
    h.recycle.mockImplementation(async (_id: string, _userId: string, _listId: string, text: string) => {
      if (text === "milk") throw boom;
      return null;
    });
    const res = await POST(req({ text: "milk, eggs", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["eggs"]);
    expect((await res.json()).items.map((i: { text: string }) => i.text)).toEqual(["eggs"]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("skips the item when the recycle itself fails, instead of inserting a new copy", async () => {
    const boom = new Error("Recycle update failed");
    h.recycle.mockRejectedValue(boom);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    // Nothing was written and the only item failed: a 500 the queue retries (safe, no duplicate).
    expect(res.status).toBe(500);
    expect(h.recycle).toHaveBeenCalledWith(OLD, "u1", "L", "milk");
    expect(inserted()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("never runs the recycler for a typed add without a recycleId", async () => {
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect(h.recycle).not.toHaveBeenCalled();
    expect(inserted()).toEqual(["milk", "eggs"]);
  });
```

Current, the last two tests:
```ts
  it("returns the recycled row when the recycle succeeds", async () => {
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockResolvedValue({ ...completedMilk, completed: false, completed_at: null, position: 9 });
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(inserted()).toEqual([]);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
  });

  it("inserts a new item when the item to recycle is genuinely gone (recycleItem answers null)", async () => {
    h.find.mockResolvedValue([completedMilk]);
    h.recycle.mockResolvedValue(null);
```
Replacement:
```ts
  it("returns the recycled row when the recycle succeeds", async () => {
    h.recycle.mockResolvedValue(recycledMilk);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual([]);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
  });

  it("inserts a new item when there is nothing to recycle (recycleItem answers null)", async () => {
    h.recycle.mockResolvedValue(null);
```
(The rest of that last test stays.)

`__tests__/unit/items-route-db-errors.test.ts`, recycler mock only. The "neither recycles" assertion must bite, so the body now carries a recycleId and the spy is `recycleItem`:

Current:
```ts
  findRecyclable: vi.fn(async () => [] as { id: string; text: string }[]),
```
Replacement:
```ts
  recycle: vi.fn(async () => null),
```

Current:
```ts
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: h.findRecyclable, recycleItem: async () => null }));
```
Replacement:
```ts
vi.mock("@/src/services/item-recycler", () => ({ recycleItem: h.recycle }));
```

Current:
```ts
  h.findRecyclable.mockClear();
```
Replacement:
```ts
  h.recycle.mockClear();
```

Current:
```ts
    const res = await POST(req("POST", { text: "milk, eggs" }), params);
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(h.findRecyclable).not.toHaveBeenCalled();
```
Replacement:
```ts
    const res = await POST(req("POST", { text: "milk, eggs", recycleId: MILK }), params);
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(h.recycle).not.toHaveBeenCalled();
```

`__tests__/unit/voice-handler-failures.test.ts`:

Current:
```ts
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "L1");
```
Replacement:
```ts
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "L1", "milk");
```

Insert this test right before `  it("findFuzzyMatch rejects: voice.itemFailed and no insert", async () => {`:
```ts
  it("a fuzzy recycle hands recycleItem the matched item's own text, so its same-text check accepts it", async () => {
    h.fuzzy!.mockResolvedValue([{ id: "old-milk", text: "milk", completed: true, completed_at: null, deleted_at: null, position: 1 }]);
    h.recycle!.mockResolvedValue({ id: "old-milk", text: "milk", completed: false, completed_at: null, deleted_at: null, position: 4 });
    await speak([{ action: "add", text: "milks", targetList: "Groceries" }]);
    expect(h.recycle).toHaveBeenCalledWith("old-milk", "u1", "L1", "milk");
    expect(texts()).toEqual(["Added to Groceries:\n- milk (recycled)"]);
    expect(itemWrites()).toEqual([]);
  });

```

`__tests__/unit/recycle-scoping.test.ts`: the route now passes the client's id on purpose, and the guard lives in the service, so the call-site rules change. Replace the whole file with:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

// 5eb9dc4 closed a cross-list write: recycleItem used to be called with the
// client's raw recycleId, so any authenticated user could pass an arbitrary
// item id from someone else's list and have it resurrected/re-attributed into
// theirs. Since the sync repair (spec 2026-10-29, H8) the route hands the
// client's recycleId to recycleItem, and the service is the guard: its lookup
// is scoped to list_id and to live rows, it reuses only a row with the
// expected text, and its update is scoped to list_id again. The behaviour is
// proven in recycle-replay.test.ts and item-recycler.test.ts; this file keeps
// the call-site rules a future caller could break without any test noticing:
// all three queries keep list_id, and every call passes listId and the text.

const root = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(full)) acc.push(full);
  }
  return acc;
}

/**
 * Find `recycleItem(...)` call sites in a source string, returning each
 * call's raw argument text. Excludes the `export async function recycleItem(`
 * declaration itself — that's the definition, not a caller.
 */
function findRecycleItemCalls(source: string): string[] {
  const calls: string[] = [];
  const regex = /recycleItem\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    if (/function\s*$/.test(before)) continue; // the declaration, not a call
    calls.push(match[1]);
  }
  return calls;
}

describe("recycleItem scoping", () => {
  const routePath = resolve(root, "app/api/lists/[id]/items/route.ts");
  const routeSource = readFileSync(routePath, "utf8");

  it("POST /api/lists/[id]/items makes one recycleItem call, with the list and the item's text", () => {
    // The text is what lets recycleItem refuse an id that names some other item, and
    // return an already-active item unchanged instead of a second copy.
    const calls = findRecycleItemCalls(routeSource);
    expect(calls.length, "expected exactly one recycleItem( call in this route").toBe(1);
    expect(calls[0].split(",").map((a) => a.trim())).toEqual(["recycleId", "auth.userId", "listId", "text"]);
  });

  const recyclerPath = resolve(root, "src/services/item-recycler.ts");
  const recyclerSource = readFileSync(recyclerPath, "utf8");

  it("recycleItem scopes all three of its queries to list_id, not just id", () => {
    // Scoped to the recycleItem function body on purpose: other functions in
    // this file (findRecyclableItems, findFuzzyMatch) also filter by
    // list_id, so an unscoped assertion over the whole file would pass even
    // if recycleItem's own lookup, max-position read or update lost its guard.
    const start = recyclerSource.indexOf("export async function recycleItem");
    expect(start, "recycleItem export not found in item-recycler.ts").toBeGreaterThanOrEqual(0);
    const nextExportIdx = recyclerSource.indexOf(
      "export",
      start + "export async function recycleItem".length
    );
    const fn = recyclerSource.slice(
      start,
      nextExportIdx === -1 ? recyclerSource.length : nextExportIdx
    );
    expect(fn.length).toBeGreaterThan(0);

    const occurrences = fn.split('.eq("list_id", listId)').length - 1;
    expect(
      occurrences,
      `recycleItem must scope its lookup, its max-position read and its update by ` +
        `.eq("list_id", listId); found ${occurrences} occurrence(s). The route passes the ` +
        `client's recycleId straight in, so a lost guard lets a cross-list itemId reach the write.`
    ).toBe(3);
  });

  it("every recycleItem( call site across app/ and src/ passes listId and the expected text", () => {
    // A future caller cannot silently omit listId or the text — this asserts on
    // argument count, not on the names passed (the route's names are checked
    // above); its job is to keep a call that drops either from ever being
    // reintroduced, here or in a new caller.
    const files = [...walk(resolve(root, "app")), ...walk(resolve(root, "src"))];
    const callSites: { file: string; args: string }[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const args of findRecycleItemCalls(source)) {
        callSites.push({ file: file.replace(root + "/", ""), args });
      }
    }

    expect(
      callSites.length,
      `expected exactly 2 live recycleItem( call sites (route.ts + recycleOrThrow in voice-handler.ts), ` +
        `found ${callSites.length}: ${callSites.map((c) => c.file).join(", ")}`
    ).toBe(2);

    for (const { file, args } of callSites) {
      const argCount = args.split(",").length;
      expect(
        argCount,
        `recycleItem( call in ${file} passes ${argCount} argument(s) (${args.trim()}); ` +
          `it must pass exactly 4 (itemId, userId, listId, text) so neither listId nor the text check can be silently omitted`
      ).toBe(4);
    }
  });
});
```

- [ ] **Step 10: Run and see green.**

```bash
npx vitest run __tests__/unit/recycle-replay.test.ts __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/voice-handler-failures.test.ts
npx vitest run
npx tsc --noEmit
npx eslint "app/api/lists/[id]/items/route.ts" src/services/item-recycler.ts src/services/voice-handler.ts __tests__/helpers/fake-items-table.ts __tests__/unit/recycle-replay.test.ts __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/voice-handler-failures.test.ts
```
Expected: all pass, tsc and eslint print nothing. The other test files that still mock `findRecyclableItems: async () => []` next to `recycleItem` keep working; the extra mock export is unused and harmless, and they are left as they are.

- [ ] **Step 11: Make each check bite.** Change one thing at a time, run `npx vitest run __tests__/unit/recycle-replay.test.ts __tests__/unit/item-recycler.test.ts`, see the named tests go red, and restore:
1. In `recycleItem` change `if (!item.completed) {` to `if (false) {`. Red: "returns an item that is already active unchanged ...", "a replay of the same recycle returns the item unchanged with 201 and writes nothing", and "a second device recycling ...".
2. Remove `.is("deleted_at", null)` from the lookup. Red: "looks the id up among this list's live rows only ..." and "a deleted item stays deleted ...".
3. Change the text check `if (normalizeForCompare(...) !== normalizeForCompare(...)) {` to `if (false) {`. Red: both "returns null and writes nothing for ... item whose text is not the expected one", plus "an active item whose text was changed meanwhile ..." and "a completed item with different text ...".
4. Remove `.eq("list_id", listId)` from the lookup only. Red: "looks the id up among this list's live rows only ..." and "an id from another list is never touched ...". `recycle-scoping.test.ts` "scopes all three of its queries" also goes red.
5. In the route's batch loop, change `if (recycleId) {` to `if (false) {`. Red in `recycle-replay.test.ts`: "the first delivery recycles ...", "a replay of the same recycle ..." and "a second device ..." (each inserts `new-1`). This is the state the audit reproduced. The Step 4 run on the old route showed the same red for the replay and second-device tests.

- [ ] **Step 12: Commit.**

```bash
git add __tests__/helpers/fake-items-table.ts __tests__/unit/recycle-replay.test.ts src/services/item-recycler.ts "app/api/lists/[id]/items/route.ts" src/services/voice-handler.ts __tests__/unit/item-recycler.test.ts __tests__/unit/items-post-recycle-failure.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/recycle-scoping.test.ts __tests__/unit/voice-handler-failures.test.ts src/utils/pick-recyclable.ts __tests__/unit/pick-recyclable.test.ts
git commit -m "$(cat <<'EOF'
fix(items): a repeated recycle lands once instead of adding a second copy

A queue replay after a lost response, or a second device tapping the same
suggestion, found the item already active and inserted a second one.
recycleItem now takes the expected text and returns an already-active
same-text item unchanged; the route hands it the recycleId, and the
list/live-row/text checks live in the service (voice shares them).
pickRecyclable has no caller left and is removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```
(`git add` on the two deleted paths stages their deletion.)

---

### Task 2b: Clear completed and Unmark all act only on the shown items (H11, server side)

**Files:**
- Create: `__tests__/unit/clear-completed-route.test.ts`
- Modify: `src/schemas/items.ts`, `app/api/lists/[id]/items/clear-completed/route.ts`, `app/api/lists/[id]/items/unmark-completed/route.ts`
- Test (update to the new contract): `__tests__/unit/unmark-completed-route.test.ts` (whole file replaced; the old one posted no body), `__tests__/unit/items-route-db-errors.test.ts` (bulk cases now send a body), `__tests__/unit/request-body-routes.test.ts` (both routes now read a JSON body, so they join its table)

**Interfaces:** Produces `clearCompletedSchema` and `unmarkCompletedSchema`, the same object as `unskipAllSchema`: `z.object({ itemIds: z.array(z.string().uuid()).min(1).max(500) })`. Both routes require `{ itemIds }`. They answer 400 with no write for a missing, empty, temp-id or >500 list, and their 200 responses are unchanged. Consumed by T5 (client sends the shown ids, skipping `temp-` ids, and makes no request when the list is empty).

- [ ] **Step 1: Write the failing Clear completed test (the audit's repro: soap unticked but queued, a collaborator's just-ticked item).** Create `__tests__/unit/clear-completed-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real route over an in-memory items table; auth and the rate limiter are faked.
// H11: Clear completed acts only on the completed items the user's screen showed.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { POST } from "@/app/api/lists/[id]/items/clear-completed/route";

const SOAP = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const EGGS = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const TEA = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e04";
const params = { params: Promise.resolve({ id: "L" }) };
const clear = (body: unknown) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items/clear-completed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const done = { completed: true, completed_at: "2026-10-29T09:00:00.000Z" };
const deleted = () => h.db.rows.filter((r) => r.deleted_at).map((r) => r.id).sort();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({ id: MILK, text: "milk", ...done }),
    // The user unticked soap; that change has not reached the server yet.
    itemRow({ id: SOAP, text: "soap", ...done }),
    // A collaborator ticked eggs a moment ago; this screen never showed it as done.
    itemRow({ id: EGGS, text: "eggs", ...done }),
    itemRow({ id: TEA, text: "tea", ...done, recurring: true }),
  ]);
});

describe("POST /api/lists/[id]/items/clear-completed", () => {
  it("soft-deletes only the shown completed items, never one the screen showed as active or never showed", async () => {
    const res = await clear({ itemIds: [MILK] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1, clearedIds: [MILK] });
    expect(deleted()).toEqual([MILK]);
    expect(h.db.rows.find((r) => r.id === SOAP)?.deleted_at).toBeNull();
    expect(h.db.rows.find((r) => r.id === EGGS)?.deleted_at).toBeNull();
  });

  it("skips a shown id that no longer matches: unticked, parked recurring or already deleted", async () => {
    h.db.rows.find((r) => r.id === SOAP)!.completed = false;
    h.db.rows.find((r) => r.id === EGGS)!.deleted_at = "2026-10-29T08:00:00.000Z";

    const res = await clear({ itemIds: [MILK, SOAP, EGGS, TEA] });

    expect(await res.json()).toEqual({ cleared: 1, clearedIds: [MILK] });
    expect(h.db.rows.find((r) => r.id === TEA)?.deleted_at).toBeNull();
    expect(h.db.rows.find((r) => r.id === EGGS)?.deleted_at).toBe("2026-10-29T08:00:00.000Z");
  });

  it("never touches another list's row", async () => {
    h.db.rows.find((r) => r.id === MILK)!.list_id = "OTHER";

    const res = await clear({ itemIds: [MILK] });

    expect(await res.json()).toEqual({ cleared: 0, clearedIds: [] });
    expect(deleted()).toEqual([]);
  });

  it.each([
    ["no itemIds field", {}],
    ["an empty list", { itemIds: [] }],
    ["an unsynced temp id", { itemIds: [MILK, "temp-1-0.5"] }],
    ["more than 500 ids", { itemIds: Array.from({ length: 501 }, () => MILK) }],
  ])("answers 400 and writes nothing for %s", async (_label, body) => {
    const res = await clear(body);

    expect(res.status).toBe(400);
    expect(h.db.calls).toEqual([]);
    expect(deleted()).toEqual([]);
  });
});
```

- [ ] **Step 2: Replace `__tests__/unit/unmark-completed-route.test.ts`** with the scoped contract. The old file posted no body and asserted the unscoped filter set; its first test's checks are kept here: one update, no lists read, values `completed:false, completed_at:null`. Its "reminders type" test pinned a lists read that the route no longer makes, and "does not read the lists table" still covers that.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real route over an in-memory items table; auth and the rate limiter are faked.
// H11: Unmark all acts only on the completed items the user's screen showed.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { table: string; op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { POST } from "@/app/api/lists/[id]/items/unmark-completed/route";

const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const EGGS = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const BREAD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e05";
const params = { params: Promise.resolve({ id: "L" }) };
const unmark = (body: unknown) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items/unmark-completed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const done = { completed: true, completed_at: "2026-10-29T09:00:00.000Z" };
const row = (id: string) => h.db.rows.find((r) => r.id === id)!;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({ id: MILK, text: "milk", ...done }),
    itemRow({ id: BREAD, text: "bread", ...done }),
    // A collaborator ticked eggs a moment ago; this screen never showed it as done.
    itemRow({ id: EGGS, text: "eggs", ...done }),
  ]);
});

describe("POST /api/lists/[id]/items/unmark-completed", () => {
  it("flips only the shown completed items back with a single update and does not read the lists table", async () => {
    const res = await unmark({ itemIds: [MILK, BREAD] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 2, unmarkedIds: [MILK, BREAD] });
    expect(h.db.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
    expect(row(MILK)).toMatchObject({ completed: false, completed_at: null });
    expect(row(BREAD)).toMatchObject({ completed: false, completed_at: null });
    expect(row(EGGS)).toMatchObject(done);
  });

  it("skips a shown id that is no longer completed, or deleted, or in another list", async () => {
    row(BREAD).deleted_at = "2026-10-29T08:00:00.000Z";
    row(EGGS).list_id = "OTHER";

    const res = await unmark({ itemIds: [MILK, BREAD, EGGS] });

    expect(await res.json()).toEqual({ unmarked: 1, unmarkedIds: [MILK] });
    expect(row(BREAD)).toMatchObject(done);
    expect(row(EGGS)).toMatchObject(done);
  });

  it.each([
    ["no itemIds field", {}],
    ["an empty list", { itemIds: [] }],
    ["an unsynced temp id", { itemIds: [MILK, "temp-1-0.5"] }],
    ["more than 500 ids", { itemIds: Array.from({ length: 501 }, () => MILK) }],
  ])("answers 400 and writes nothing for %s", async (_label, body) => {
    const res = await unmark(body);

    expect(res.status).toBe(400);
    expect(h.db.calls).toEqual([]);
    expect(row(MILK)).toMatchObject(done);
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

Run: `npx vitest run __tests__/unit/clear-completed-route.test.ts __tests__/unit/unmark-completed-route.test.ts`
Expected: 11 failed, 2 passed. On the clear side, "soft-deletes only the shown completed items" fails because `deleted()` is `[EGGS, MILK, SOAP]`, "never touches another list's row" fails, and all four 400 cases answer 200. On the unmark side, "flips only the shown completed items" fails (EGGS unmarked) and all four 400 cases fail. The two "skips a shown id ..." tests pass already; they guard the predicates the routes keep.

- [ ] **Step 4: Add the shared schema.** In `src/schemas/items.ts`, current:
```ts
// POST /api/lists/[id]/items/unskip-all
// .uuid(): the client sends only synced ids; items still on a temp- id are
// restored through their own queued skip mutation.
export const unskipAllSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
});
```
Replacement:
```ts
// A bulk action's body: the ids of the items the user's screen showed, so the route never
// touches a row the user did not see (a collaborator's tick a moment ago, or an item whose
// own change is still queued). .uuid(): the client sends only synced ids; an item still on
// a temp- id is not on the server yet.
const shownItemIdsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
});

// POST /api/lists/[id]/items/unskip-all (items on a temp- id are restored through their
// own queued skip mutation)
export const unskipAllSchema = shownItemIdsSchema;

// POST /api/lists/[id]/items/clear-completed
export const clearCompletedSchema = shownItemIdsSchema;

// POST /api/lists/[id]/items/unmark-completed
export const unmarkCompletedSchema = shownItemIdsSchema;
```

- [ ] **Step 5: Scope Clear completed.** In `app/api/lists/[id]/items/clear-completed/route.ts`:

Current:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Replacement:
```ts
import { dbError } from "@/src/lib/api-errors";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { clearCompletedSchema } from "@/src/schemas/items";
```

Current:
```ts
  const supabase = createServerClient();

  // Soft-delete all completed items (for undo support). Recurring staples are
```
Replacement:
```ts
  const body = await readJsonBody(request, "items/clear-completed/POST");
  const parsed = parseBody(clearCompletedSchema, body);
  if (!parsed.success) return parsed.response;

  const supabase = createServerClient();

  // Soft-delete the completed items the user saw (for undo support). Scoping to their ids
  // means an item ticked by a collaborator a moment ago, or one the user unticked while
  // that change is still queued, is never cleared. Recurring staples are
```

Current:
```ts
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
```
Replacement:
```ts
    .update({ deleted_at: new Date().toISOString() })
    .in("id", parsed.data.itemIds)
    .eq("list_id", listId)
```
(`.eq("completed", true)`, `.eq("recurring", false)`, `.is("deleted_at", null)` and `.select("id")` stay, so `clear-completed.test.ts`'s recurring check still holds.)

- [ ] **Step 6: Scope Unmark all.** In `app/api/lists/[id]/items/unmark-completed/route.ts`:

Current:
```ts
import { dbError } from "@/src/lib/api-errors";
```
Replacement:
```ts
import { dbError } from "@/src/lib/api-errors";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { unmarkCompletedSchema } from "@/src/schemas/items";
```

Current:
```ts
  const supabase = createServerClient();

  // Flip all completed items back to active (non-destructive)
  const { data: unmarked, error } = await supabase
    .from("items")
    .update({ completed: false, completed_at: null })
    .eq("list_id", listId)
```
Replacement:
```ts
  const body = await readJsonBody(request, "items/unmark-completed/POST");
  const parsed = parseBody(unmarkCompletedSchema, body);
  if (!parsed.success) return parsed.response;

  const supabase = createServerClient();

  // Flip the completed items the user saw back to active (non-destructive). Scoping to their
  // ids means an item ticked by a collaborator a moment ago is never unmarked.
  const { data: unmarked, error } = await supabase
    .from("items")
    .update({ completed: false, completed_at: null })
    .in("id", parsed.data.itemIds)
    .eq("list_id", listId)
```

- [ ] **Step 7: Update the other existing tests that post no body.**

`__tests__/unit/items-route-db-errors.test.ts`, in `describe("bulk item routes"`, current:
```ts
    ["clear completed", () => CLEAR(req("POST", undefined, "items/clear-completed"), params), "[items/clear-completed/POST] Clear completed failed:"],
    ["unmark all", () => UNMARK(req("POST", undefined, "items/unmark-completed"), params), "[items/unmark-completed/POST] Unmark completed failed:"],
```
Replacement:
```ts
    ["clear completed", () => CLEAR(req("POST", { itemIds: [MILK] }, "items/clear-completed"), params), "[items/clear-completed/POST] Clear completed failed:"],
    ["unmark all", () => UNMARK(req("POST", { itemIds: [MILK] }, "items/unmark-completed"), params), "[items/unmark-completed/POST] Unmark completed failed:"],
```

`__tests__/unit/request-body-routes.test.ts`. Current:
```ts
import { POST as unskipAllPOST } from "@/app/api/lists/[id]/items/unskip-all/route";
```
Replacement:
```ts
import { POST as unskipAllPOST } from "@/app/api/lists/[id]/items/unskip-all/route";
import { POST as clearCompletedPOST } from "@/app/api/lists/[id]/items/clear-completed/route";
import { POST as unmarkCompletedPOST } from "@/app/api/lists/[id]/items/unmark-completed/route";
```
Current:
```ts
  ["POST items/unskip-all", "POST", "items/unskip-all/POST", (r) => unskipAllPOST(r, listCtx), { itemIds: [ITEM] }],
```
Replacement:
```ts
  ["POST items/unskip-all", "POST", "items/unskip-all/POST", (r) => unskipAllPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST items/clear-completed", "POST", "items/clear-completed/POST", (r) => clearCompletedPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST items/unmark-completed", "POST", "items/unmark-completed/POST", (r) => unmarkCompletedPOST(r, listCtx), { itemIds: [ITEM] }],
```

- [ ] **Step 8: Run and see green.**

```bash
npx vitest run __tests__/unit/clear-completed-route.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/request-body-routes.test.ts __tests__/unit/clear-completed.test.ts __tests__/unit/unskip-all-route.test.ts __tests__/unit/list-background-saves.test.ts
npx vitest run
npx tsc --noEmit
npx eslint src/schemas/items.ts "app/api/lists/[id]/items/clear-completed/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" __tests__/unit/clear-completed-route.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/request-body-routes.test.ts
```
Expected: all pass. `list-background-saves.test.ts` stays green: its fake server answers "POST clear-completed" / "POST unmark-completed" by key and ignores the body.

- [ ] **Step 9: Make each check bite.** One at a time, then restore:
1. Delete `.in("id", parsed.data.itemIds)` from the clear route. Run `npx vitest run __tests__/unit/clear-completed-route.test.ts`. Red: "soft-deletes only the shown completed items ..." and "never touches another list's row".
2. Delete `.in("id", parsed.data.itemIds)` from the unmark route. Run `npx vitest run __tests__/unit/unmark-completed-route.test.ts`. Red: "flips only the shown completed items back ...".
3. Delete the three `readJsonBody` / `parseBody` / `if (!parsed.success)` lines and the `.in(...)` line from the clear route. Red: the four "answers 400 and writes nothing for ..." cases, and `request-body-routes` "POST items/clear-completed" (no 400 on a non-JSON body).

- [ ] **Step 10: Commit.**

```bash
git add src/schemas/items.ts "app/api/lists/[id]/items/clear-completed/route.ts" "app/api/lists/[id]/items/unmark-completed/route.ts" __tests__/unit/clear-completed-route.test.ts __tests__/unit/unmark-completed-route.test.ts __tests__/unit/items-route-db-errors.test.ts __tests__/unit/request-body-routes.test.ts
git commit -m "$(cat <<'EOF'
fix(items): clear completed and unmark all act only on the items the screen showed

Both routes updated every completed row in the list, so a collaborator's
tick from a moment ago, or an item whose untick was still queued, got
cleared or unmarked. They now take { itemIds } (the schema unskip-all
already uses) and add .in("id", itemIds) to their filters.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 2c: Ticks, skips and "on the way" keep the tap time (H19, server side)

**Files:**
- Create: `__tests__/unit/items-patch-tap-time.test.ts`
- Modify: `src/schemas/items.ts` (`updateItemSchema`), `app/api/lists/[id]/items/route.ts` (`tapTime` helper and the PATCH stamps)

**Interfaces:** Produces `updateItemSchema.at: z.iso.datetime({ offset: true }).optional()`. The PATCH stamps `completed_at` (when `completed: true`), `skipped_at` (when `skipped: true`) and `ordered_at` (when `ordered: true`) with `clamp(at, now - 24h, now)`, or with now when there is no `at`. A non-ISO `at` gets 400. Consumed by T3, whose executor-factory sends `at: new Date(m.timestamp).toISOString()` for toggle / skip / order.

- [ ] **Step 1: Write the failing test.** Create `__tests__/unit/items-patch-tap-time.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items PATCH over an in-memory items table; auth, the rate limiter and the
// categorizer are faked. H19: a tick, skip or "on the way" replayed from the offline queue
// keeps the time of the tap (`at`), clamped to the last 24 hours and never in the future.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

import { PATCH } from "@/app/api/lists/[id]/items/route";

const ITEM = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-29T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const params = { params: Promise.resolve({ id: "L" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: ITEM, ...body }),
    }),
    params
  );
const row = () => h.db.rows[0];

// Each action, the body that turns it on, and the column that records when.
const ACTIONS = [
  ["tick", { completed: true }, "completed_at"],
  ["skip", { skipped: true }, "skipped_at"],
  ["on the way", { ordered: true }, "ordered_at"],
] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk" })]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PATCH items stamps the tap time", () => {
  describe.each(ACTIONS)("%s", (_label, on, column) => {
    it("records the tap time sent in `at`, not the sync time", async () => {
      const res = await patch({ ...on, at: iso(NOW - 3 * HOUR) });
      expect(res.status).toBe(200);
      expect(row()[column]).toBe(iso(NOW - 3 * HOUR));
    });

    it("accepts a tap time with a UTC offset", async () => {
      await patch({ ...on, at: "2026-10-29T15:30:00+03:00" });
      expect(row()[column]).toBe("2026-10-29T12:30:00.000Z");
    });

    it("clamps a tap time older than 24 hours to 24 hours ago", async () => {
      await patch({ ...on, at: iso(NOW - 3 * 24 * HOUR) });
      expect(row()[column]).toBe(iso(NOW - 24 * HOUR));
    });

    it("clamps a tap time in the future (a fast device clock) to now", async () => {
      await patch({ ...on, at: iso(NOW + 2 * HOUR) });
      expect(row()[column]).toBe(iso(NOW));
    });

    it("uses the server time when no `at` is sent (an entry queued before this change)", async () => {
      await patch({ ...on });
      expect(row()[column]).toBe(iso(NOW));
    });

    it("stamps the same time on a duplicate delivery", async () => {
      await patch({ ...on, at: iso(NOW - 10 * MIN) });
      vi.setSystemTime(NOW + HOUR);
      await patch({ ...on, at: iso(NOW - 10 * MIN) });
      expect(row()[column]).toBe(iso(NOW - 10 * MIN));
    });
  });

  it("still clears completed_at on an untick that carries `at`", async () => {
    h.db.rows[0].completed = true;
    h.db.rows[0].completed_at = iso(NOW - HOUR);
    await patch({ completed: false, at: iso(NOW - 5 * MIN) });
    expect(row()).toMatchObject({ completed: false, completed_at: null });
  });

  it("answers 400 and writes nothing for an `at` that is not an ISO date-time", async () => {
    const res = await patch({ completed: true, at: "yesterday" });
    expect(res.status).toBe(400);
    expect(h.db.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**

Run: `npx vitest run __tests__/unit/items-patch-tap-time.test.ts`
Expected: 13 failed, 7 passed. For each of the three actions, "records the tap time", "accepts a tap time with a UTC offset", "clamps ... older than 24 hours" and "stamps the same time on a duplicate delivery" fail; the column holds the server's now. The "400 ... not an ISO date-time" test also fails: zod strips the unknown `at`, so the request answers 200. The "in the future", "no `at`" and untick tests already pass; they pin the fallback.

- [ ] **Step 3: Accept `at` in the schema.** In `src/schemas/items.ts`, inside `updateItemSchema`, current:
```ts
  deleted_at: z.null().optional(),
  categoryId: z.string().uuid().optional(),
});
```
Replacement:
```ts
  deleted_at: z.null().optional(),
  categoryId: z.string().uuid().optional(),
  // When the user tapped (ISO date-time), for completed_at / skipped_at / ordered_at. Optional:
  // entries queued before the client sent it carry none, and the server uses its own time.
  at: z.iso.datetime({ offset: true }).optional(),
});
```
(Anchor on `updateItemSchema`: this is the first `categoryId: z.string().uuid().optional(),` followed by `});` in the file.)

- [ ] **Step 4: Stamp the tap time.** In `app/api/lists/[id]/items/route.ts`:

Current:
```ts
// Upper bound for position values. Requires BIGINT column (migration 010).
const MAX_SAFE_POSITION = Number.MAX_SAFE_INTEGER;
```
Replacement:
```ts
// Upper bound for position values. Requires BIGINT column (migration 010).
const MAX_SAFE_POSITION = Number.MAX_SAFE_INTEGER;

// How far back a tap time is honoured: the offline queue's own 24-hour limit.
const TAP_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

// The time for completed_at / skipped_at / ordered_at: when the user tapped (`at`), so a
// change replayed from the offline queue, or delivered twice, keeps the time it was made
// rather than the time it synced. Clamped to the last 24 hours and never in the future, so
// a wrong device clock can't push an item far out of order.
function tapTime(at: string | undefined): string {
  const now = Date.now();
  if (!at) return new Date(now).toISOString();
  return new Date(Math.min(now, Math.max(now - TAP_TIME_WINDOW_MS, Date.parse(at)))).toISOString();
}
```

In `PATCH`, current:
```ts
  const patchData: Record<string, unknown> = {};

  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed
      ? new Date().toISOString()
      : null;
  }
```
Replacement:
```ts
  const patchData: Record<string, unknown> = {};
  const stamp = tapTime(updates.at);

  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed ? stamp : null;
  }
```

Current:
```ts
    patchData.skipped_at = updates.skipped ? new Date().toISOString() : null;
```
Replacement:
```ts
    patchData.skipped_at = updates.skipped ? stamp : null;
```

Current:
```ts
    patchData.ordered_at = updates.ordered ? new Date().toISOString() : null;
```
Replacement:
```ts
    patchData.ordered_at = updates.ordered ? stamp : null;
```
(`at` is never copied into `patchData`: the object is built field by field. `restoreRecurring`, which clears these stamps, is unchanged, and so is DELETE's `deleted_at`.)

- [ ] **Step 5: Run and see green.**

```bash
npx vitest run __tests__/unit/items-patch-tap-time.test.ts __tests__/unit/items-patch-db-errors.test.ts __tests__/unit/items-completion-no-reminders.test.ts __tests__/unit/request-body-routes.test.ts
npx vitest run
npx tsc --noEmit
npx eslint src/schemas/items.ts "app/api/lists/[id]/items/route.ts" __tests__/unit/items-patch-tap-time.test.ts
```
Expected: all pass.

- [ ] **Step 6: Make each check bite.** One at a time; run `npx vitest run __tests__/unit/items-patch-tap-time.test.ts`; restore:
1. `const stamp = tapTime(updates.at);` to `const stamp = tapTime(undefined);`. Red: "records the tap time ...", "accepts a tap time with a UTC offset", "clamps ... older than 24 hours" and "stamps the same time on a duplicate delivery", for all three actions.
2. `Math.min(now, Math.max(now - TAP_TIME_WINDOW_MS, Date.parse(at)))` to `Math.min(now, Date.parse(at))`. Red: "clamps a tap time older than 24 hours to 24 hours ago", times 3.
3. The same expression to `Math.max(now - TAP_TIME_WINDOW_MS, Date.parse(at))`. Red: "clamps a tap time in the future (a fast device clock) to now", times 3.
4. In the schema, `at: z.iso.datetime({ offset: true }).optional(),` to `at: z.string().optional(),`. Red: "answers 400 and writes nothing for an `at` that is not an ISO date-time".

- [ ] **Step 7: Commit.**

```bash
git add src/schemas/items.ts "app/api/lists/[id]/items/route.ts" __tests__/unit/items-patch-tap-time.test.ts
git commit -m "$(cat <<'EOF'
fix(items): ticks, skips and on-the-way keep the tap time

The PATCH stamped completed_at / skipped_at / ordered_at at delivery, so
an offline tick synced hours later, or a duplicate delivery, got the sync
time. It now takes an optional ISO `at` and uses it clamped to the last
24 hours and never in the future; without `at` it keeps using now.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

---

### Task 2d: Home card counts match the list (decision 4)

**Files:**
- Create: `supabase/migrations/030_list_item_counts_match_list.sql`, `__tests__/unit/migration-030-list-item-counts.test.ts`

**Interfaces:** Produces `get_list_item_counts(p_list_ids UUID[]) RETURNS TABLE (list_id UUID, active_count BIGINT, completed_count BIGINT)`. The signature, return type and attributes are the same as migration 008, so `app/api/lists/route.ts` and `components/ListCard.tsx` need no change. Only the counts change: active leaves out skipped items, completed leaves out parked recurring ones. The migration applies on deploy through `scripts/migrate.mjs`; never run it by hand, and never `npm run build`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/unit/migration-030-list-item-counts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";
import { isActiveItem, isParkedRecurringItem } from "@/src/utils/list-helpers";

// Owner decision 4 (docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md): a Home card's
// counts match the list's own sections. There is no Postgres in the test run, so this reads the two
// FILTER predicates out of the migration, evaluates them on every combination of the item states,
// and compares the result with the predicates the list page itself uses.
const DIR = resolve(process.cwd(), "supabase/migrations");
const FILE = "030_list_item_counts_match_list.sql";
const raw = readFileSync(resolve(DIR, FILE), "utf8");
// Comments may quote other forms, so check only the SQL that runs.
const sql = raw.replace(/--.*$/gm, "");

function filterOf(alias: string): string {
  const m = sql.match(new RegExp(`COUNT\\(\\*\\)\\s+FILTER\\s*\\(\\s*WHERE\\s+([^()]*?)\\s*\\)\\s+AS\\s+${alias}\\b`, "i"));
  if (!m) throw new Error(`no COUNT(*) FILTER (WHERE ...) AS ${alias} in ${FILE}`);
  return m[1];
}

// Evaluates the small SQL subset these predicates use: `i.col = true|false`, `i.col IS [NOT] NULL`, AND.
function evaluate(predicate: string, row: ItemData): boolean {
  return predicate.split(/\s+AND\s+/i).every((term) => {
    const cell = (col: string) => (row as unknown as Record<string, unknown>)[col];
    let m: RegExpMatchArray | null;
    if ((m = term.trim().match(/^i\.(\w+)\s*=\s*(true|false)$/i))) return cell(m[1]) === (m[2].toLowerCase() === "true");
    if ((m = term.trim().match(/^i\.(\w+)\s+IS\s+NULL$/i))) return cell(m[1]) == null;
    if ((m = term.trim().match(/^i\.(\w+)\s+IS\s+NOT\s+NULL$/i))) return cell(m[1]) != null;
    throw new Error(`unsupported term in the counts filter: ${term}`);
  });
}

// Every combination of the states that decide an item's section. Deleted rows are left out:
// the function's WHERE drops them before either count.
const ROWS: ItemData[] = [];
for (const completed of [false, true])
  for (const skipped_at of [null, "2026-10-29T10:00:00.000Z"])
    for (const ordered_at of [null, "2026-10-29T10:00:00.000Z"])
      for (const recurring of [false, true])
        ROWS.push({
          id: `${completed}-${!!skipped_at}-${!!ordered_at}-${recurring}`,
          text: "x", completed, completed_at: completed ? "2026-10-29T11:00:00.000Z" : null,
          deleted_at: null, skipped_at, ordered_at, recurring, position: 1,
          created_by: null, creator_name: null, edited_by: null, editor_name: null,
        });

describe(`migration ${FILE}`, () => {
  it("counts as active exactly the items the list shows as still to do (skipped ones left out)", () => {
    const active = filterOf("active_count");
    for (const row of ROWS) expect(evaluate(active, row), row.id).toBe(isActiveItem(row));
  });

  it("counts as completed exactly the items the list shows under Completed (parked recurring ones left out)", () => {
    const completed = filterOf("completed_count");
    for (const row of ROWS) expect(evaluate(completed, row), row.id).toBe(row.completed && !isParkedRecurringItem(row));
  });

  it("still drops deleted rows before counting", () => {
    expect(sql).toMatch(/WHERE\s+i\.list_id\s*=\s*ANY\(p_list_ids\)\s+AND\s+i\.deleted_at\s+IS\s+NULL/i);
  });

  it("keeps the function's signature and attributes, so CREATE OR REPLACE keeps its grants", () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+get_list_item_counts\s*\(\s*p_list_ids\s+UUID\[\]\s*\)/i);
    expect(sql).toMatch(/RETURNS\s+TABLE\s*\(\s*list_id\s+UUID\s*,\s*active_count\s+BIGINT\s*,\s*completed_count\s+BIGINT\s*\)/i);
    expect(sql).toMatch(/LANGUAGE\s+sql\s+SECURITY\s+DEFINER\s+STABLE\s+SET\s+search_path\s*=\s*public\s*;/i);
  });

  it("has no transaction control and drops nothing", () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it("is the last migration that defines get_list_item_counts, so its version is the one that applies", () => {
    const definers = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => /FUNCTION\s+get_list_item_counts\b/i.test(readFileSync(resolve(DIR, f), "utf8")));
    expect(definers.at(-1)).toBe(FILE);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**

Run: `npx vitest run __tests__/unit/migration-030-list-item-counts.test.ts`
Expected: the file fails to load with `ENOENT: no such file or directory, open '.../supabase/migrations/030_list_item_counts_match_list.sql'`.

- [ ] **Step 3: Write the migration.** Create `supabase/migrations/030_list_item_counts_match_list.sql`. Before you do, check that 030 is still the next free number: `ls supabase/migrations | tail -1` must print `029_drop_reminders_data.sql`. If a later number exists, use the next one and rename `FILE` in the test.

```sql
-- Home card counts match the list's own sections (docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md,
-- owner decision 4):
-- - active_count: a skipped ("Not available") item sits in its own section, not with the items still to buy.
-- - completed_count: a parked recurring item waits in the Recurring drawer, not under Completed.
-- Same name, arguments, return type and attributes as migration 008, so CREATE OR REPLACE keeps its
-- grants and the lists route reads it unchanged. Safe to re-run: no BEGIN/COMMIT, nothing dropped.
CREATE OR REPLACE FUNCTION get_list_item_counts(p_list_ids UUID[])
RETURNS TABLE (
  list_id UUID,
  active_count BIGINT,
  completed_count BIGINT
) AS $$
  SELECT
    i.list_id,
    COUNT(*) FILTER (WHERE i.completed = false AND i.skipped_at IS NULL) AS active_count,
    COUNT(*) FILTER (WHERE i.completed = true AND i.recurring = false) AS completed_count
  FROM items i
  WHERE i.list_id = ANY(p_list_ids)
    AND i.deleted_at IS NULL
  GROUP BY i.list_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;
```
(`items.recurring` is `BOOLEAN NOT NULL DEFAULT false` (migration 021), so `= false` is exact.)

- [ ] **Step 4: Run and see green.**

```bash
npx vitest run __tests__/unit/migration-030-list-item-counts.test.ts __tests__/unit/lists-route-db-errors.test.ts
npx vitest run
npx tsc --noEmit
npx eslint __tests__/unit/migration-030-list-item-counts.test.ts
```
Expected: all pass.

- [ ] **Step 5: Make each check bite.** One at a time; rerun the migration test; restore:
1. `WHERE i.completed = false AND i.skipped_at IS NULL)` to `WHERE i.completed = false)`. Red: "counts as active exactly the items the list shows as still to do ...".
2. `WHERE i.completed = true AND i.recurring = false)` to `WHERE i.completed = true)`. Red: "counts as completed exactly the items the list shows under Completed ...".

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/030_list_item_counts_match_list.sql __tests__/unit/migration-030-list-item-counts.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 030 aligns Home card counts with the list

get_list_item_counts counted skipped items as still to buy and parked
recurring items as done, so a grocery card's numbers differed from the
list. Active now leaves out skipped items and completed leaves out parked
recurring ones, the list's own sections. Applies on deploy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
EOF
)"
```

### Task 3: Engine: one ordered, persistent path for every change

One reviewable diff would be too big (a new engine, the executor rewrite of every handler, page and provider wiring), so this task is three sub-tasks. Each ends green and commits.

- **3a** adds the engine module and its storage changes. Nothing uses it yet.
- **3b** sends every change through it: one executor (executor-factory), the hook becomes a thin adapter, inline `execute` closures go, the create follow-up moves to the page's success handler, `at` (tap time) is sent, `restore` is added, and the page flushes once a JWT exists.
- **3c** adds recovery wiring: a dropped change refreshes the list, the provider replays every list after auth, and a 401 asks for a fresh token.

**State this task starts from (T1 and T2 ran first on the same tree):**
- T1 moved `app/list/[id]/page.tsx` to `app/(app)/list/[id]/page.tsx`. Its default export is now the page component itself (`export default function ListPage()`, no `TelegramProvider` wrapper, `import { useTelegram } from "@/components/TelegramProvider"`). The first load still runs in `useEffect(() => { if (isReady) fetchItems(); }, [isReady, fetchItems]);`, now with a T1 comment above it. The loading and error branches render `<OfflineIndicator />`.
- T1 rewrote `components/TelegramProvider.tsx`. The parts this task anchors on are still there: `const { jwt, jwtRef, ... } = useJWTRefresh(...)`, the `useReconnectOrchestrator({...})` destructure (which now also returns `requestTokenRefresh`, a throttled forced token refresh that T1 exposes in the context), and the comment `// Keep heartbeat ref in sync with orchestrator's runReconnectRef`. The import line is `import { useReconnectOrchestrator, MAX_RETRIES } from "@/src/hooks/useReconnectOrchestrator";`.
- T1 updated the import paths in `__tests__/unit/list-type-switch.test.ts`, `__tests__/unit/grouped-list-wiring.test.ts` and `__tests__/unit/restore-skipped-wiring.test.ts`. They mock `useMutationQueue` as `{ addMutation, flushQueue }`, which stays valid. This task does not touch them.
- T2 changed only server files (items route and schemas, recycler, bulk routes, a migration). The PATCH accepts an optional `at` (ISO datetime) for toggle/skip/order. None of T2's files are touched here.
- T1 and T2 left these files as they are on `main` today: `src/hooks/useMutationQueue.ts`, `src/utils/mutation-queue.ts`, `src/utils/executor-factory.ts`, `src/hooks/useItemHandlers.ts`, `src/hooks/useListDragDrop.ts` and their tests. The "Current" snippets below for these files are exact.
- The page and provider snippets below were checked against T1's sandbox version. If T1's final text differs around an anchor (a comment or a blank line), apply the same change at the same code (the meaning of each pair is given above it).

---

### Task 3a: The sync engine module

**Files:**
- Create: `src/sync/engine.ts`
- Modify: `src/utils/mutation-queue.ts` (cap 500, `onEvict`, `rewritePayloads`; in-flight tracking stays until 3b)
- Test (create): `__tests__/unit/sync-engine.test.ts`
- Test (modify): `__tests__/unit/mutation-queue.test.ts`

**Interfaces:**
- Consumes: `MutationQueue` and `QueuedMutation` from `src/utils/mutation-queue.ts` (persisted shape unchanged: `{ id, type, payload, timestamp }` under `mutation_queue:<listId>`).
- Produces (exactly as shared-context, plus two marked extensions):
  ```ts
  export type { QueuedMutation } from "@/src/utils/mutation-queue"; // { id: string; type: string; payload: Record<string, unknown>; timestamp: number }
  export type Executor = () => Promise<unknown>;
  export type ExecutorFactory = (m: QueuedMutation, getJwt: () => string) => Executor | null;
  export type MutationErrorInfo = { mutationId: string; type: string; httpStatus: number | null; message: string; dropped: boolean; payload: Record<string, unknown> };
  export type EngineHandlers = { getJwt: () => string | null; executorFactory: ExecutorFactory; onError?: (info: MutationErrorInfo) => void; onSuccess?: (m: QueuedMutation, result: unknown) => void; onAuthNeeded?: () => void };
  export interface SyncEngine { attach(handlers: EngineHandlers): () => void; add(m: { id: string; type: string; payload: Record<string, unknown> }): void; flush(): Promise<void>; pendingFields(itemId: string): Set<string>; resolveId(id: string): string }
  export function getSyncEngine(listId: string): SyncEngine;
  export function flushAllQueues(getJwt: () => string | null, executorFactory: ExecutorFactory, onAuthNeeded?: () => void): Promise<void>; // EXTENSION: optional 3rd param
  export function resetSyncEngines(): void; // EXTENSION: tests only (a page reload)
  // src/utils/mutation-queue.ts
  export const MAX_QUEUE_SIZE = 500;
  enqueue(mutation: Omit<QueuedMutation, "timestamp">, onEvict?: (evicted: QueuedMutation[]) => void): string;
  rewritePayloads(rewrite: (payload: Record<string, unknown>) => Record<string, unknown>): void;
  ```
- Engine rules:
  - Chain key: `payload.itemId`, `payload.tempId` for "create", and `payload.recycleId` for "recycle" (EXTENSION: see concerns). Keys resolve through the temp→real map.
  - Barriers: "reorder" and "unskip-all".
  - Field map exactly as shared-context, plus "unskip-all" → `skipped_at` for every id in `payload.itemIds` (EXTENSION).
  - Temp map: localStorage key `sync_temp_ids:<listId>`, `{ [tempId]: { id, at } }`, pruned after 48 h.
  - Kept failures retry with backoff (2 s doubling to 60 s) unless `navigator.onLine === false`.
  - At most 6 requests in flight per list.

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H3 | `src/hooks/useMutationQueue.ts:190-197` flushes on mount before the provider sets a JWT. `:137-145` builds no executor while `getJwt()` is null. `:161-165` then dequeues every entry with a `console.log`. | `flush()` and the pump return before touching the queue while `getJwt()` is null. Only an unknown type (factory returns null) is dropped, and it is reported. A 401 keeps the entry, holds the list until the next flush and calls `onAuthNeeded` once. | `sync-engine.test.ts` › "a flush with no token leaves every saved change in place…", "a flush with no token touches nothing…", "a change made with no token is saved, not sent…", "a 401 keeps the change, asks once for a reconnect…", "drops a change whose type has no executor…" |
| H4 | `useMutationQueue.ts:172-188` sends every change at once, ignoring older queued or in-flight work for the item. `:94-96` returns early while a flush runs. `:84-86` keeps going past a kept failure. | Pump in queue order. An entry waits while an earlier entry with its chain key is queued, in flight or parked. Barriers wait for everything earlier and hold everything later. A kept failure is parked in place until the next flush or a backoff retry. `flush()` resolves when what it sent has landed. | "a tick that failed stays ahead of the untick made after it", "a change waits while the previous one for that item is in flight", "a flush while a change is in flight does not send it twice", "a flush resolves once what it sent has landed", "a reorder waits for every earlier change…", "a failed change keeps its place after a reload", "retries a change kept after a server error, with growing delays", "does not retry on a timer while the device reports it is offline" |
| H5 (engine) | `useMutationQueue.ts:100,125-153`: the temp→real map lives for one flush, never covers the online path, and is never written back (`:125` clones). `orderedIds` are never remapped. | A change keyed on a `temp-` id waits behind that create. On the create's row the engine saves temp→real, rewrites stored `itemId` / `orderedIds` / `itemIds`, and resolves keys, so real-id changes share the chain. A temp change whose create is gone is dropped and reported. A create answered with no row is dropped and reported. | "a tick on a temp item is sent with the real id once the create returns", "a change made with the real id still waits behind the temp item's chain", "…stored with the real id, so a reload sends it right", "a reload before the create returns replays the create…", "a drag made while an item was pending sends the item's real id", "drops and reports a change for a temp item that was never created…", "when a create is refused, the changes waiting on it are dropped…", "drops and reports a create that was answered without an item", "pendingFields covers queued and in-flight changes…" |
| H15 (engine) | `src/utils/mutation-queue.ts:13,55-58` silently splices past 100. `useMutationQueue.ts:105-111` drops >24 h entries with a `console.log`. Only the open list page ever flushes. | Cap 500 with `onEvict`; the engine reports each eviction. Expiry on flush is reported. `flushAllQueues` flushes every `mutation_queue:*` key with fallback handlers. A detached page leaves fallback handlers so retries continue. | "past 500 queued changes the oldest is evicted and reported", "a change older than 24 hours is dropped and reported on the next flush", "flushAllQueues sends the saved changes of a list no page has open", "flushAllQueues sends nothing without a token", "a list keeps retrying after its page closes…"; `mutation-queue.test.ts` › "trims oldest items when exceeding 500, and hands them to onEvict" |
| H17 (engine) | `useMutationQueue.ts:76-81`. A 4xx drop reported only to the page's toast. | A 4xx drop is dequeued and reported with `dropped: true` (the page refresh comes in 3c). | "drops a change the server refuses with a 4xx, and reports it" |

- [ ] **Step 1: Write the failing engine test.** Create `__tests__/unit/sync-engine.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSyncEngine,
  flushAllQueues,
  resetSyncEngines,
  type EngineHandlers,
  type ExecutorFactory,
  type MutationErrorInfo,
  type QueuedMutation,
  type SyncEngine,
} from "@/src/sync/engine";

// Runs the real engine over a fake localStorage and a fake executor factory. Each request
// the factory "sends" is logged as "<type> <target> <value>"; replies are set per line and
// consumed in order: "ok" (default), an HTTP status, "neterr" (offline) or "hold" (in
// flight until released). `server` keeps the last value each item got, as the items PATCH
// does (last write wins).
type Reply = "ok" | number | "neterr" | "hold";

const DAY = 24 * 60 * 60 * 1000;

function world(listId = "L") {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  });
  vi.stubGlobal("navigator", { onLine: true });

  const sent: string[] = [];
  const server = new Map<string, unknown>();
  const replies = new Map<string, Reply[]>();
  const held = new Map<string, (r: Reply) => void>();
  const noRow = new Set<string>(); // temp ids whose create answers without an item
  const jwt = { current: "jwt" as string | null };

  const factory: ExecutorFactory = (m, getJwt) => {
    if (m.type === "bogus") return null;
    return async () => {
      const p = m.payload;
      const target =
        m.type === "create" ? p.tempId : m.type === "reorder" ? (p.orderedIds as string[]).join(",") : p.itemId;
      const line = `${m.type} ${String(target)}${"value" in p ? ` ${String(p.value)}` : ""}`;
      sent.push(line);
      expect(getJwt()).toBe("jwt");
      let reply = replies.get(line)?.shift() ?? "ok";
      if (reply === "hold") reply = await new Promise<Reply>((resolve) => held.set(line, resolve));
      if (reply === "neterr") throw new TypeError("Failed to fetch");
      if (typeof reply === "number") throw new Error(`Change failed: ${reply}`);
      if (m.type === "create") return noRow.has(p.tempId as string) ? {} : { id: `r-${p.tempId}` };
      if ("value" in p) server.set(String(p.itemId), p.value);
      return {};
    };
  };

  const errors: MutationErrorInfo[] = [];
  const successes: QueuedMutation[] = [];
  let authNeeded = 0;
  const handlers: EngineHandlers = {
    getJwt: () => jwt.current,
    executorFactory: factory,
    onError: (info) => errors.push(info),
    onSuccess: (m) => successes.push(m),
    onAuthNeeded: () => authNeeded++,
  };
  let engine: SyncEngine = getSyncEngine(listId);
  let detach = engine.attach(handlers);
  let n = 0;

  return {
    engine: () => engine,
    factory,
    sent,
    server,
    jwt,
    errors,
    successes,
    noRow,
    authNeeded: () => authNeeded,
    when: (line: string, ...r: Reply[]) => replies.set(line, r),
    release: (line: string, r: Reply = "ok") => held.get(line)!(r),
    add: (type: string, payload: Record<string, unknown>) => {
      const id = `m${++n}`;
      engine.add({ id, type, payload: { listId, ...payload } });
      return id;
    },
    stored: (id = listId) => JSON.parse(storage.get(`mutation_queue:${id}`) ?? "[]") as QueuedMutation[],
    seed: (id: string, entries: QueuedMutation[]) => storage.set(`mutation_queue:${id}`, JSON.stringify(entries)),
    detach: () => detach(),
    // A page reload: every engine is forgotten, storage stays, the page attaches again.
    reload: () => {
      resetSyncEngines();
      engine = getSyncEngine(listId);
      detach = engine.attach(handlers);
    },
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

const entry = (id: string, type: string, payload: Record<string, unknown>, timestamp = Date.now()): QueuedMutation => ({
  id,
  type,
  payload: { listId: "L", ...payload },
  timestamp,
});

beforeEach(() => {
  resetSyncEngines();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetSyncEngines();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("nothing is sent or thrown away without a token (H3)", () => {
  it("a flush with no token leaves every saved change in place and sends nothing", async () => {
    const w = world();
    w.seed("L", [entry("a", "toggle", { itemId: "i1", value: true }), entry("b", "edit", { itemId: "i2", value: "x" })]);
    w.jwt.current = null;
    w.reload();

    await w.engine().flush();
    await settle();

    expect(w.sent).toEqual([]);
    expect(w.stored().map((m) => m.id)).toEqual(["a", "b"]);
    expect(w.errors).toEqual([]);
  });

  it("a flush with no token touches nothing, not even a change past 24 hours", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    vi.setSystemTime(Date.now() + DAY + 1);

    await w.engine().flush();
    expect(w.stored()).toHaveLength(1);
    expect(w.errors).toEqual([]);

    w.jwt.current = "jwt";
    await w.engine().flush();
    expect(w.errors).toMatchObject([{ dropped: true, message: "Expired after 24 hours" }]);
  });

  it("a change made with no token is saved, not sent, and goes out on the flush after the token arrives", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toEqual([]);
    expect(w.stored()).toHaveLength(1);

    w.jwt.current = "jwt";
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a 401 keeps the change, asks once for a reconnect, and holds later changes until the next flush", async () => {
    const w = world();
    w.when("toggle i1 true", 401);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i3", value: true });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.authNeeded()).toBe(1);
    expect(w.errors).toMatchObject([{ httpStatus: 401, dropped: false }]);
    expect(w.stored()).toHaveLength(2);

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i3 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("drops a change whose type has no executor, and reports it", async () => {
    const w = world();
    w.add("bogus", { itemId: "i1" });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "bogus", dropped: true, httpStatus: null }]);
  });

  it("drops a change the server refuses with a 4xx, and reports it", async () => {
    const w = world();
    w.when("toggle i1 true", 404);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "toggle", httpStatus: 404, dropped: true }]);
  });
});

describe("one item's changes land in the order they were made (H4)", () => {
  it("a tick that failed stays ahead of the untick made after it", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i1", value: false });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
    expect(w.stored()).toEqual([]);
  });

  it("a change waits while the previous one for that item is in flight", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i1", value: false });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
  });

  it("a flush while a change is in flight does not send it twice", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    void w.engine().flush();
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a flush resolves once what it sent has landed", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    let done = false;
    void w.engine().flush().then(() => (done = true));
    await settle();
    expect(done).toBe(false);

    w.release("toggle i1 true");
    await settle();
    expect(done).toBe(true);
  });

  it("changes to different items do not wait for each other", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i2", value: true });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i2 true"]);
  });

  it("a reorder waits for every earlier change and holds every later one", async () => {
    const w = world();
    w.when("toggle i1 true", "hold");
    w.add("toggle", { itemId: "i1", value: true });
    w.add("reorder", { orderedIds: ["i1", "i2"] });
    w.add("toggle", { itemId: "i2", value: true });
    await settle();
    expect(w.sent).toEqual(["toggle i1 true"]);

    w.release("toggle i1 true");
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "reorder i1,i2", "toggle i2 true"]);
  });

  it("a failed change keeps its place after a reload", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.add("toggle", { itemId: "i1", value: false });
    await settle();

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true", "toggle i1 false"]);
    expect(w.server.get("i1")).toBe(false);
  });

  it("retries a change kept after a server error, with growing delays", async () => {
    const w = world();
    w.when("toggle i1 true", 500, 503);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    expect(w.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(w.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3999);
    await settle();
    expect(w.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(w.sent).toHaveLength(3);
    expect(w.stored()).toEqual([]);
  });

  it("does not retry on a timer while the device reports it is offline", async () => {
    const w = world();
    vi.stubGlobal("navigator", { onLine: false });
    w.when("toggle i1 true", "neterr");
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    expect(w.sent).toEqual(["toggle i1 true"]);
    expect(w.stored()).toHaveLength(1);
  });
});

describe("changes on a just-added item wait for its create (H5)", () => {
  it("a tick on a temp item is sent with the real id once the create returns", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.sent).toEqual(["create temp-1"]);

    w.release("create temp-1");
    await settle();

    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);
    expect(w.engine().resolveId("temp-1")).toBe("r-temp-1");
    expect(w.errors).toEqual([]);
  });

  it("a change made with the real id still waits behind the temp item's chain", async () => {
    const w = world();
    w.when("toggle r-temp-1 true", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);

    w.add("edit", { itemId: "r-temp-1", value: "oat milk" });
    w.add("toggle", { itemId: "temp-1", value: false }); // a handler still holding the temp id
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true"]);
    expect(w.stored().map((m) => m.payload.itemId)).toEqual(["r-temp-1", "r-temp-1", "r-temp-1"]);

    w.release("toggle r-temp-1 true");
    await settle();
    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true", "edit r-temp-1 oat milk", "toggle r-temp-1 false"]);
  });

  it("a change that failed after its create landed is stored with the real id, so a reload sends it right", async () => {
    const w = world();
    w.when("toggle r-temp-1 true", 503);
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.stored().map((m) => m.payload.itemId)).toEqual(["r-temp-1"]);

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["create temp-1", "toggle r-temp-1 true", "toggle r-temp-1 true"]);
    expect(w.engine().resolveId("temp-1")).toBe("r-temp-1");
    expect(w.errors.filter((e) => e.dropped)).toEqual([]);
  });

  it("a reload before the create returns replays the create, then its changes with the real id", async () => {
    const w = world();
    w.when("create temp-1", "neterr");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();
    expect(w.stored().map((m) => m.type)).toEqual(["create", "toggle"]);

    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual(["create temp-1", "create temp-1", "toggle r-temp-1 true"]);
    expect(w.stored()).toEqual([]);
  });

  it("a drag made while an item was pending sends the item's real id", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("reorder", { orderedIds: ["temp-1", "i2"] });
    await settle();
    w.release("create temp-1");
    await settle();

    expect(w.sent).toEqual(["create temp-1", "reorder r-temp-1,i2"]);
  });

  it("drops and reports a change for a temp item that was never created, without a request", async () => {
    const w = world();
    w.seed("L", [entry("old", "toggle", { itemId: "temp-9", value: true })]);
    w.reload();
    await w.engine().flush();

    expect(w.sent).toEqual([]);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ mutationId: "old", type: "toggle", dropped: true }]);
  });

  it("when a create is refused, the changes waiting on it are dropped and reported, not sent", async () => {
    const w = world();
    w.when("create temp-1", 400);
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    await settle();

    expect(w.sent).toEqual(["create temp-1"]);
    expect(w.stored()).toEqual([]);
    expect(w.errors.map((e) => [e.type, e.dropped])).toEqual([["create", true], ["toggle", true]]);
  });

  it("drops and reports a create that was answered without an item", async () => {
    const w = world();
    w.noRow.add("temp-1");
    w.add("create", { tempId: "temp-1", text: "milk" });
    await settle();

    expect(w.stored()).toEqual([]);
    expect(w.successes).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "create", dropped: true }]);
  });

  it("pendingFields covers queued and in-flight changes, under the temp and the real id", async () => {
    const w = world();
    w.when("create temp-1", "hold");
    w.when("toggle r-temp-1 true", "hold");
    w.add("create", { tempId: "temp-1", text: "milk" });
    w.add("toggle", { itemId: "temp-1", value: true });
    w.add("edit", { itemId: "temp-1", value: "oat milk" });
    w.add("reorder", { orderedIds: ["i2", "temp-1"] });
    await settle();
    expect(w.engine().pendingFields("temp-1")).toEqual(new Set(["created", "completed", "completed_at", "text", "position"]));
    expect(w.engine().pendingFields("i2")).toEqual(new Set(["position"]));

    w.release("create temp-1");
    await settle();
    expect(w.engine().pendingFields("r-temp-1")).toEqual(new Set(["completed", "completed_at", "text", "position"]));
    expect(w.engine().pendingFields("temp-1")).toEqual(new Set(["completed", "completed_at", "text", "position"]));

    w.release("toggle r-temp-1 true");
    await settle();
    expect(w.engine().pendingFields("r-temp-1")).toEqual(new Set());
  });
});

describe("a full queue or an old change is reported, never silent (H15)", () => {
  it("past 500 queued changes the oldest is evicted and reported", async () => {
    const w = world();
    w.jwt.current = null;
    for (let i = 0; i <= 500; i++) w.add("toggle", { itemId: `i${i}`, value: true });

    expect(w.stored()).toHaveLength(500);
    expect(w.stored()[0].payload.itemId).toBe("i1");
    expect(w.errors).toMatchObject([{ mutationId: "m1", dropped: true }]);
  });

  it("a change older than 24 hours is dropped and reported on the next flush", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("toggle", { itemId: "i1", value: true });
    vi.setSystemTime(Date.now() + DAY + 1);
    w.jwt.current = "jwt";

    await w.engine().flush();

    expect(w.sent).toEqual([]);
    expect(w.stored()).toEqual([]);
    expect(w.errors).toMatchObject([{ type: "toggle", dropped: true, message: "Expired after 24 hours" }]);
  });

  it("flushAllQueues sends the saved changes of a list no page has open", async () => {
    const w = world();
    w.seed("other", [{ ...entry("o", "toggle", { itemId: "o1", value: true }), payload: { listId: "other", itemId: "o1", value: true } }]);
    resetSyncEngines();

    await flushAllQueues(() => "jwt", w.factory);

    expect(w.sent).toEqual(["toggle o1 true"]);
    expect(w.stored("other")).toEqual([]);
  });

  it("flushAllQueues sends nothing without a token", async () => {
    const w = world();
    w.seed("other", [entry("o", "toggle", { itemId: "o1", value: true })]);
    resetSyncEngines();

    await flushAllQueues(() => null, w.factory);

    expect(w.sent).toEqual([]);
    expect(w.stored("other")).toHaveLength(1);
  });

  it("a list keeps retrying after its page closes, without calling the closed page", async () => {
    const w = world();
    w.when("toggle i1 true", 500);
    w.add("toggle", { itemId: "i1", value: true });
    await settle();
    w.detach();

    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 true"]);
    expect(w.stored()).toEqual([]);
    expect(w.successes).toEqual([]);
  });
});

describe("page callbacks", () => {
  it("hands the server's row of a create to onSuccess", async () => {
    const w = world();
    w.add("create", { tempId: "temp-1", text: "milk" });
    await settle();

    expect(w.successes.map((m) => m.payload.tempId)).toEqual(["temp-1"]);
  });

  it("a callback that throws is logged and never stops the item's next change", async () => {
    const w = world();
    const engine = w.engine();
    engine.attach({ getJwt: () => "jwt", executorFactory: w.factory, onSuccess: () => { throw new Error("page bug"); } });
    w.add("toggle", { itemId: "i1", value: true });
    w.add("toggle", { itemId: "i1", value: false });
    await settle();

    expect(w.sent).toEqual(["toggle i1 true", "toggle i1 false"]);
    expect(console.error).toHaveBeenCalledWith("[SyncEngine] The onSuccess handler failed:", { listId: "L" }, expect.any(Error));
  });
});
```

- [ ] **Step 2: Update the queue storage test.** In `__tests__/unit/mutation-queue.test.ts`, the cap test encodes the old silent cap of 100. Replace it, and add a `rewritePayloads` test:

Current (1):

```ts
  it("trims oldest items when exceeding 100", () => {
    const queue = new MutationQueue("list-1");
    for (let i = 0; i < 105; i++) {
      queue.enqueue({ id: `m${i}`, type: "add", payload: {} });
    }
    const items = queue.getQueue();
    expect(items).toHaveLength(100);
    // Oldest 5 should have been dropped
    expect(items[0].id).toBe("m5");
    expect(items[99].id).toBe("m104");
```

Replace with:

```ts
  it("trims oldest items when exceeding 500, and hands them to onEvict", () => {
    const queue = new MutationQueue("list-1");
    const evicted: string[] = [];
    for (let i = 0; i < 505; i++) {
      queue.enqueue({ id: `m${i}`, type: "add", payload: {} }, (gone) => evicted.push(...gone.map((m) => m.id)));
    }
    const items = queue.getQueue();
    expect(items).toHaveLength(500);
    // Oldest 5 should have been dropped, and reported
    expect(items[0].id).toBe("m5");
    expect(items[499].id).toBe("m504");
    expect(evicted).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("rewritePayloads saves rewritten payloads and leaves untouched entries as they were", () => {
    const queue = new MutationQueue("list-1");
    queue.enqueue({ id: "m1", type: "toggle", payload: { itemId: "temp-1" } });
    queue.enqueue({ id: "m2", type: "toggle", payload: { itemId: "i2" } });
    queue.rewritePayloads((p) => (p.itemId === "temp-1" ? { ...p, itemId: "real-1" } : p));
    expect(queue.getQueue().map((m) => m.payload.itemId)).toEqual(["real-1", "i2"]);
```

- [ ] **Step 3: Run and watch them fail.**

  Run: `npx vitest run __tests__/unit/sync-engine.test.ts __tests__/unit/mutation-queue.test.ts`

  Expected:
  - `sync-engine.test.ts` fails to load because `@/src/sync/engine` does not exist.
  - `mutation-queue.test.ts` fails "trims oldest items when exceeding 500…" (`expected 100 to have a length of 500`) and "rewritePayloads saves…" (`queue.rewritePayloads is not a function`).

- [ ] **Step 4: Replace `src/utils/mutation-queue.ts`** with this whole file. It raises the cap, reports evictions and adds `rewritePayloads`. In-flight tracking stays until 3b, because the old hook still uses it:

```ts
/**
 * Offline mutation queue with localStorage persistence: the storage layer of the sync
 * engine (src/sync/engine.ts), which decides what is sent and when.
 */

export interface QueuedMutation {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export const MAX_QUEUE_SIZE = 500;

export class MutationQueue {
  private storageKey: string;
  // Ephemeral, per-session, never persisted: which queued mutations have a request
  // in flight right now. A queued mutation is only removed on success, so without
  // this a flush triggered mid-request (focus / visibilitychange / the 45-minute
  // timer) re-runs the same executor and the request lands twice.
  private inFlight = new Set<string>();

  constructor(listId: string) {
    this.storageKey = `mutation_queue:${listId}`;
  }

  getQueue(): QueuedMutation[] {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error(`[MutationQueue] Could not read the offline queue (${this.storageKey}):`, err);
      return [];
    }
  }

  private saveQueue(queue: QueuedMutation[]) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(queue));
    } catch (err) {
      console.error(`[MutationQueue] Could not persist the offline queue (${this.storageKey}, ${queue.length} entries):`, err);
      // localStorage full or unavailable
    }
  }

  /** Appends a change. Past MAX_QUEUE_SIZE the oldest entries are evicted and handed to `onEvict`. */
  enqueue(
    mutation: Omit<QueuedMutation, "timestamp">,
    onEvict?: (evicted: QueuedMutation[]) => void
  ): string {
    const queue = this.getQueue();
    const entry: QueuedMutation = {
      ...mutation,
      timestamp: Date.now(),
    };

    queue.push(entry);

    const evicted = queue.length > MAX_QUEUE_SIZE ? queue.splice(0, queue.length - MAX_QUEUE_SIZE) : [];

    this.saveQueue(queue);
    if (evicted.length > 0) onEvict?.(evicted);
    return mutation.id;
  }

  dequeue(id: string) {
    const queue = this.getQueue().filter((m) => m.id !== id);
    this.saveQueue(queue);
  }

  /** Rewrites stored payloads in place (e.g. a temp id swapped for the real one). `rewrite` returns the same object when nothing changes. */
  rewritePayloads(rewrite: (payload: Record<string, unknown>) => Record<string, unknown>) {
    let changed = false;
    const next = this.getQueue().map((m) => {
      const payload = rewrite(m.payload);
      if (payload === m.payload) return m;
      changed = true;
      return { ...m, payload };
    });
    if (changed) this.saveQueue(next);
  }

  clear() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (err) {
      console.warn(`[MutationQueue] Could not clear the offline queue (${this.storageKey}):`, err);
    }
  }

  markInFlight(id: string) {
    this.inFlight.add(id);
  }

  clearInFlight(id: string) {
    this.inFlight.delete(id);
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }
}
```

- [ ] **Step 5: Create `src/sync/engine.ts`:**

```ts
/**
 * The sync engine: the one path every change the user makes takes to the server, online
 * and on replay. One engine per list id lives at module level, shared by every hook
 * instance and the provider, so a remount or a second hook never sends a change twice.
 *
 * - Changes are persisted first (`mutation_queue:<listId>`), then sent by executor-factory.
 * - Changes to one item run strictly in order (its chain); "reorder" and "unskip-all" are
 *   list-wide barriers that wait for every earlier change and hold every later one.
 * - A change on a `temp-` item waits behind that item's create. When the create returns,
 *   the temp → real id pair is saved (`sync_temp_ids:<listId>`) and stored payloads are
 *   rewritten, so later changes made with either id stay in the same chain.
 * - Nothing is sent without a JWT. A 401 keeps the change and asks for a reconnect; a
 *   network failure, 5xx, 408 or 429 keeps it for a retry with backoff; any other 4xx drops
 *   it. Every drop (refused, unknown type, orphaned temp id, queue cap, 24 h expiry) is
 *   reported through onError with `dropped: true`.
 */
import { MutationQueue, type QueuedMutation } from "@/src/utils/mutation-queue";

export type { QueuedMutation } from "@/src/utils/mutation-queue";

/** Resolves with the server row ({ id, ... }) for "create" and "recycle"; throws Error("<Verb> failed: <status>") on a non-ok answer. */
export type Executor = () => Promise<unknown>;
/** null = unknown type. */
export type ExecutorFactory = (m: QueuedMutation, getJwt: () => string) => Executor | null;

export type MutationErrorInfo = {
  mutationId: string;
  type: string;
  httpStatus: number | null;
  message: string;
  dropped: boolean; // true if dequeued (non-retriable), false if kept for retry
  payload: Record<string, unknown>;
};

export type EngineHandlers = {
  getJwt: () => string | null;
  executorFactory: ExecutorFactory;
  onError?: (info: MutationErrorInfo) => void;
  onSuccess?: (m: QueuedMutation, result: unknown) => void;
  onAuthNeeded?: () => void; // a 401: entry kept, provider should reconnect
};

export interface SyncEngine {
  /** The open list page; returns detach. Without an attached page the engine runs with the handlers flushAllQueues passed. */
  attach(handlers: EngineHandlers): () => void;
  /** Persists, then runs in its chain. */
  add(m: { id: string; type: string; payload: Record<string, unknown> }): void;
  /** Runs every queued entry not in flight, in chain order. No-op while getJwt() is null. */
  flush(): Promise<void>;
  /** Fields touched by queued or in-flight entries for that item (after temp → real aliasing). */
  pendingFields(itemId: string): Set<string>;
  /** The real id for a resolved temp id, else the id itself. */
  resolveId(id: string): string;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A saved temp → real pair is only needed while a change made before the create returned
// can still be queued, which is at most MAX_AGE_MS.
const TEMP_ID_MAX_AGE_MS = 2 * MAX_AGE_MS;
// Requests one list sends at once. Each chain still sends one at a time.
const MAX_IN_FLIGHT = 6;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60 * 1000;
const QUEUE_PREFIX = "mutation_queue:";
const TEMP_IDS_PREFIX = "sync_temp_ids:";
const BARRIER_TYPES = new Set(["reorder", "unskip-all"]);

// Item fields each change type touches (spec §4); "deleted" and "created" stand for presence.
const FIELDS: Record<string, string[]> = {
  toggle: ["completed", "completed_at"],
  edit: ["text"],
  skip: ["skipped_at"],
  order: ["ordered_at"],
  "set-category": ["category_id", "category_locked"],
  "set-recurring": ["recurring"],
  "restore-recurring": ["recurring"],
  delete: ["deleted"],
  restore: ["deleted"],
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isTempId = (id: string) => id.startsWith("temp-");
const reportedOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** The item a change is about: its itemId, the tempId of a create, the recycled item of a recycle. */
function itemOf(m: QueuedMutation): string | undefined {
  if (m.type === "create") return str(m.payload.tempId);
  if (m.type === "recycle") return str(m.payload.recycleId);
  return str(m.payload.itemId);
}

/** [item id, fields] pairs a change touches. */
function touched(m: QueuedMutation): [string, string[]][] {
  if (m.type === "reorder") return strings(m.payload.orderedIds).map((id) => [id, ["position"]]);
  if (m.type === "unskip-all") return strings(m.payload.itemIds).map((id) => [id, ["skipped_at"]]);
  const id = itemOf(m);
  if (!id) return [];
  if (m.type === "create" || m.type === "recycle") return [[id, ["created"]]];
  const fields = FIELDS[m.type];
  return fields ? [[id, fields]] : [];
}

class ListSyncEngine implements SyncEngine {
  private readonly queue: MutationQueue;
  private readonly tempIdsKey: string;
  private tempIds = new Map<string, { id: string; at: number }>();
  private attached: EngineHandlers | null = null;
  private fallback: EngineHandlers | null = null;
  private readonly inFlight = new Set<string>();
  // Kept after a failure: not sent again until the next flush (a retry, a reconnect, a mount).
  private readonly parked = new Set<string>();
  // Set by a 401: nothing more is sent until the next flush.
  private authHold = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly listId: string) {
    this.queue = new MutationQueue(listId);
    this.tempIdsKey = `${TEMP_IDS_PREFIX}${listId}`;
    this.loadTempIds();
  }

  private get handlers(): EngineHandlers | null {
    return this.attached ?? this.fallback;
  }

  attach(handlers: EngineHandlers): () => void {
    this.attached = handlers;
    return () => {
      if (this.attached !== handlers) return;
      this.attached = null;
      // Keep sending after the page closes, without its screen callbacks.
      if (!this.fallback) {
        this.fallback = {
          getJwt: handlers.getJwt,
          executorFactory: handlers.executorFactory,
          onAuthNeeded: handlers.onAuthNeeded,
        };
      }
    };
  }

  /** Handlers used while no page is attached (flushAllQueues). */
  setFallback(handlers: EngineHandlers) {
    this.fallback = handlers;
  }

  add(m: { id: string; type: string; payload: Record<string, unknown> }): void {
    this.queue.enqueue({ id: m.id, type: m.type, payload: this.rewrite(m.payload) }, (evicted) => {
      for (const e of evicted) {
        console.error("[SyncEngine] Offline queue full, dropping its oldest change:", this.ctx(e));
        this.report(e, null, "Evicted: the offline queue is full", true);
      }
    });
    this.pump();
  }

  async flush(): Promise<void> {
    const handlers = this.handlers;
    if (!handlers || !handlers.getJwt()) return;
    this.clearRetry();
    this.parked.clear();
    this.authHold = false;
    this.expire();
    this.pump();
    await this.whenIdle();
  }

  pendingFields(itemId: string): Set<string> {
    const target = this.resolveId(itemId);
    const fields = new Set<string>();
    for (const m of this.queue.getQueue()) {
      for (const [id, touchedFields] of touched(m)) {
        if (this.resolveId(id) === target) for (const f of touchedFields) fields.add(f);
      }
    }
    return fields;
  }

  resolveId(id: string): string {
    return this.tempIds.get(id)?.id ?? id;
  }

  dispose() {
    this.clearRetry();
    this.attached = null;
    this.fallback = null;
    this.resolveIdle();
  }

  // --- sending ---

  private chainKey(m: QueuedMutation): string {
    const item = itemOf(m);
    return item ? this.resolveId(item) : `mutation:${m.id}`;
  }

  /** Starts every entry whose chain is free, in queue order. */
  private pump(): void {
    const handlers = this.handlers;
    if (!handlers || this.authHold) return;
    const jwt = handlers.getJwt();
    if (!jwt) return;

    const queue = this.queue.getQueue();
    const pendingCreates = new Set(
      queue.filter((m) => m.type === "create").map((m) => str(m.payload.tempId))
    );
    const busyChains = new Set<string>();
    let earlierAny = false;
    let earlierBarrier = false;
    let droppedAny = false;

    for (const m of queue) {
      const barrier = BARRIER_TYPES.has(m.type);
      const key = this.chainKey(m);
      const blocked = barrier ? earlierAny : earlierBarrier || busyChains.has(key);
      earlierAny = true;
      if (barrier) earlierBarrier = true;
      else busyChains.add(key);
      if (blocked || this.inFlight.has(m.id) || this.parked.has(m.id)) continue;
      if (this.inFlight.size >= MAX_IN_FLIGHT) break;

      // A change on a temp id whose create is gone (refused, evicted, expired, or queued by
      // an older app version that kept no id map) can never be sent.
      if (m.type !== "create" && isTempId(key) && !pendingCreates.has(key)) {
        console.error("[SyncEngine] Change for an item that was never created, dropping it:", this.ctx(m));
        this.queue.dequeue(m.id);
        this.report(m, null, "Its item was never created", true);
        droppedAny = true;
        continue;
      }

      const resolved: QueuedMutation = { ...m, payload: this.rewrite(m.payload) };
      const executor = handlers.executorFactory(resolved, () => this.handlers?.getJwt() ?? jwt);
      if (!executor) {
        console.error("[SyncEngine] No executor for a queued change, dropping it:", this.ctx(m));
        this.queue.dequeue(m.id);
        this.report(m, null, `No executor for "${m.type}"`, true);
        droppedAny = true;
        continue;
      }
      void this.run(m, executor);
    }
    // A drop can free a chain behind it.
    if (droppedAny) this.pump();
  }

  private async run(m: QueuedMutation, executor: Executor): Promise<void> {
    this.inFlight.add(m.id);
    let result: unknown;
    let ok = false;
    try {
      result = await executor();
      ok = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/:\s*(\d{3})$/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
      if (status === 401) {
        console.warn("[SyncEngine] Change refused with 401, keeping it until the session reconnects:", this.ctx(m), err);
        this.parked.add(m.id);
        this.report(m, status, message, false);
        if (!this.authHold) {
          this.authHold = true;
          this.callHandler("onAuthNeeded", () => this.handlers?.onAuthNeeded?.());
        }
      } else if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        console.error("[SyncEngine] Change refused by the server, dropping it:", this.ctx(m), err);
        this.queue.dequeue(m.id);
        this.report(m, status, message, true);
      } else {
        const offline = status === null && (message.includes("fetch") || message.includes("network") || reportedOffline());
        console.warn(
          offline ? "[SyncEngine] Offline, keeping the change for later:" : "[SyncEngine] Change failed, keeping it for a retry:",
          this.ctx(m),
          err
        );
        this.parked.add(m.id);
        this.report(m, status, message, false);
        // While the device says it is offline, the "online" event's reconnect flushes.
        if (!reportedOffline()) this.scheduleRetry();
      }
    } finally {
      this.inFlight.delete(m.id);
    }
    if (ok) this.succeeded(m, result);
    this.pump();
    if (this.inFlight.size === 0) this.resolveIdle();
  }

  private succeeded(m: QueuedMutation, result: unknown) {
    if (m.type === "create") {
      const realId = result && typeof result === "object" ? str((result as { id?: unknown }).id) : undefined;
      if (!realId) {
        // e.g. the list hit its item limit: nothing was created.
        console.error("[SyncEngine] Create answered without an item, dropping it:", this.ctx(m));
        this.queue.dequeue(m.id);
        this.report(m, null, "Create returned no item", true);
        return;
      }
      const tempId = str(m.payload.tempId);
      if (tempId) this.recordTempId(tempId, realId);
    }
    this.queue.dequeue(m.id);
    this.retryAttempt = 0;
    this.callHandler("onSuccess", () => this.handlers?.onSuccess?.(m, result));
  }

  private expire() {
    const now = Date.now();
    for (const m of this.queue.getQueue()) {
      if (this.inFlight.has(m.id) || now - m.timestamp <= MAX_AGE_MS) continue;
      console.warn("[SyncEngine] Dropping a change older than 24 hours:", this.ctx(m));
      this.queue.dequeue(m.id);
      this.report(m, null, "Expired after 24 hours", true);
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private whenIdle(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // --- temp ids ---

  /** Swaps resolved temp ids in a payload's itemId, orderedIds and itemIds. Returns the same object when nothing changes. */
  private rewrite(payload: Record<string, unknown>): Record<string, unknown> {
    let out = payload;
    const itemId = str(payload.itemId);
    if (itemId && this.tempIds.has(itemId)) out = { ...out, itemId: this.resolveId(itemId) };
    for (const key of ["orderedIds", "itemIds"]) {
      const ids = payload[key];
      if (Array.isArray(ids) && ids.some((id) => typeof id === "string" && this.tempIds.has(id))) {
        out = { ...out, [key]: ids.map((id) => (typeof id === "string" ? this.resolveId(id) : id)) };
      }
    }
    return out;
  }

  private recordTempId(tempId: string, realId: string) {
    this.tempIds.set(tempId, { id: realId, at: Date.now() });
    try {
      localStorage.setItem(this.tempIdsKey, JSON.stringify(Object.fromEntries(this.tempIds)));
    } catch (err) {
      console.error("[SyncEngine] Could not save a created item's id:", { listId: this.listId }, err);
    }
    this.queue.rewritePayloads((p) => this.rewrite(p));
  }

  private loadTempIds() {
    try {
      const raw = localStorage.getItem(this.tempIdsKey);
      const saved: Record<string, { id?: unknown; at?: unknown }> = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      for (const [tempId, entry] of Object.entries(saved)) {
        if (typeof entry?.id === "string" && typeof entry.at === "number" && now - entry.at < TEMP_ID_MAX_AGE_MS) {
          this.tempIds.set(tempId, { id: entry.id, at: entry.at });
        }
      }
    } catch (err) {
      console.error("[SyncEngine] Could not read saved item ids:", { listId: this.listId }, err);
    }
  }

  // --- reporting ---

  // Ids and type only: payloads carry item text.
  private ctx(m: QueuedMutation) {
    return { listId: this.listId, mutationId: m.id, type: m.type };
  }

  private report(m: QueuedMutation, httpStatus: number | null, message: string, dropped: boolean) {
    this.callHandler("onError", () =>
      this.handlers?.onError?.({ mutationId: m.id, type: m.type, httpStatus, message, dropped, payload: m.payload })
    );
  }

  /** A page callback that throws must never break the engine. */
  private callHandler(name: string, call: () => void) {
    try {
      call();
    } catch (err) {
      console.error(`[SyncEngine] The ${name} handler failed:`, { listId: this.listId }, err);
    }
  }
}

const engines = new Map<string, ListSyncEngine>();

function engineFor(listId: string): ListSyncEngine {
  let engine = engines.get(listId);
  if (!engine) {
    engine = new ListSyncEngine(listId);
    engines.set(listId, engine);
  }
  return engine;
}

export function getSyncEngine(listId: string): SyncEngine {
  return engineFor(listId);
}

/** Flushes every `mutation_queue:*` list in localStorage, so a list the user doesn't reopen still syncs. */
export async function flushAllQueues(
  getJwt: () => string | null,
  executorFactory: ExecutorFactory,
  onAuthNeeded?: () => void
): Promise<void> {
  if (!getJwt()) return;
  const listIds: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(QUEUE_PREFIX)) listIds.push(key.slice(QUEUE_PREFIX.length));
    }
  } catch (err) {
    console.error("[SyncEngine] Could not list the saved offline queues:", err);
    return;
  }
  await Promise.all(
    listIds.map((listId) => {
      const engine = engineFor(listId);
      engine.setFallback({ getJwt, executorFactory, onAuthNeeded });
      return engine.flush();
    })
  );
}

/** Forgets every engine, as a page reload does. Tests only. */
export function resetSyncEngines(): void {
  for (const engine of engines.values()) engine.dispose();
  engines.clear();
}
```

- [ ] **Step 6: Run to green.**
  - `npx vitest run __tests__/unit/sync-engine.test.ts __tests__/unit/mutation-queue.test.ts` → 31 + 16 tests pass.
  - `npx vitest run` → all pass. `no-silent-catches.test.ts` stays green: every catch in the engine logs `err`.
  - `npx tsc --noEmit` → clean. The old hook still compiles: `enqueue`'s new parameter is optional and the in-flight methods are kept.
  - `npx eslint src/sync/engine.ts src/utils/mutation-queue.ts __tests__/unit/sync-engine.test.ts __tests__/unit/mutation-queue.test.ts` → clean.

- [ ] **Step 7: Make it bite.** For each row, apply the edit to `src/sync/engine.ts`, run `npx vitest run __tests__/unit/sync-engine.test.ts`, see the named test(s) go red, then restore the line.

| Remove / change | Goes red |
|---|---|
| in `flush()`: `if (!handlers \|\| !handlers.getJwt()) return;` → `if (!handlers) return;` | "a flush with no token touches nothing, not even a change past 24 hours" |
| in `pump()`: `const jwt = handlers.getJwt();\n    if (!jwt) return;` → `const jwt = handlers.getJwt() ?? "";` | "a change made with no token is saved, not sent…", "a change older than 24 hours…" |
| `earlierBarrier \|\| busyChains.has(key)` → `earlierBarrier` | "a tick that failed stays ahead…", "a change waits while the previous one…", "a failed change keeps its place after a reload", the H5 chain tests |
| `const blocked = barrier ? earlierAny : earlierBarrier \|\| busyChains.has(key);` → `const blocked = busyChains.has(key);` | "a reorder waits for every earlier change…", "a drag made while an item was pending…" |
| `if (blocked \|\| this.inFlight.has(m.id) \|\| this.parked.has(m.id)) continue;` → without `this.inFlight.has(m.id) \|\|` | "a flush while a change is in flight does not send it twice", "changes to different items do not wait…" |
| delete `this.queue.rewritePayloads((p) => this.rewrite(p));` in `recordTempId` | "a change made with the real id still waits…", "…stored with the real id, so a reload sends it right" |
| delete `if (tempId) this.recordTempId(tempId, realId);` | every H5 test that expects `r-temp-1` |
| orphan check `if (m.type !== "create" && isTempId(key) && !pendingCreates.has(key)) {` → `if (false) {` | "drops and reports a change for a temp item that was never created…", "when a create is refused…" |
| `if (!realId) {` → `if (false) {` | "drops and reports a create that was answered without an item" |
| `if (!executor) {` → `if (!executor && false) {` | "drops a change whose type has no executor…" |
| `if (status === 401) {` → `if (status === 4010) {` | "a 401 keeps the change, asks once for a reconnect…" |
| delete `this.report(e, null, "Evicted: the offline queue is full", true);` | "past 500 queued changes the oldest is evicted and reported" |
| delete `this.expire();` in `flush()` | "a change older than 24 hours is dropped and reported…" |
| delete `if (!reportedOffline()) this.scheduleRetry();` | "retries a change kept after a server error…", "a list keeps retrying after its page closes…" |
| `if (!reportedOffline()) this.scheduleRetry();` → `this.scheduleRetry();` | "does not retry on a timer while the device reports it is offline" |
| in `whenIdle`: `if (this.inFlight.size === 0) return Promise.resolve();` → `return Promise.resolve();` | "a flush resolves once what it sent has landed" |
| in `attach`'s detach: `if (!this.fallback) {` → `if (false) {` | "a list keeps retrying after its page closes…" |
| `this.callHandler("onSuccess", () => this.handlers?.onSuccess?.(m, result));` → `this.handlers?.onSuccess?.(m, result);` | "a callback that throws is logged and never stops the item's next change" |

  For the storage layer, delete `if (evicted.length > 0) onEvict?.(evicted);` in `src/utils/mutation-queue.ts`. Then "trims oldest items when exceeding 500, and hands them to onEvict" goes red. Restore it.

- [ ] **Step 8: Commit.**
  ```bash
  git add src/sync/engine.ts src/utils/mutation-queue.ts __tests__/unit/sync-engine.test.ts __tests__/unit/mutation-queue.test.ts
  git commit -m "$(cat <<'EOF'
  feat(sync): add the per-list sync engine

  One engine per list at module level: changes are persisted, then run in per-item
  chains with reorder and Restore all as list-wide barriers. A change on a temp item
  waits for its create; the temp to real id pair is saved and stored payloads are
  rewritten. Nothing is sent without a JWT, a 401 keeps the change and asks for a
  reconnect, kept failures retry with backoff, and every drop (refused, unknown
  type, orphaned temp id, cap of 500, 24 h expiry) is reported.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  EOF
  )"
  ```

---

### Task 3b: Every change goes through the engine and the executor factory

**Files:**
- Modify: `src/utils/executor-factory.ts` (types from the engine; create/recycle resolve with the row; `at` for toggle/skip/order; new `restore` case)
- Replace: `src/hooks/useMutationQueue.ts` (thin adapter over the engine)
- Create: `src/sync/overlay.ts` (`overlayPending`)
- Modify: `src/hooks/useItemHandlers.ts` (no inline `execute`; `at` in toggle/skip/order payloads; create follow-up removed)
- Modify: `src/hooks/useListDragDrop.ts` (no inline `execute`, no `jwtRef` param; drag lock ends at the drop)
- Modify: `app/(app)/list/[id]/page.tsx` (create success handler; flush once a JWT exists; drag hook call)
- Modify: `src/utils/mutation-queue.ts` (in-flight tracking removed; the engine owns it)
- Test (create): `__tests__/unit/single-executor.test.ts`, `__tests__/unit/mutation-queue-hook.test.ts`, `__tests__/unit/tap-time.test.ts`, `__tests__/unit/list-sync-wiring.test.ts`
- Test (replace): `__tests__/unit/mutation-request-parity.test.ts`
- Test (modify): `__tests__/unit/executor-factory.test.ts`, `__tests__/unit/restore-skipped-flow.test.ts`, `__tests__/unit/grouped-drag-hook.test.ts`, `__tests__/unit/mutation-queue.test.ts`

**Interfaces:**
- Consumes: everything 3a produces.
- Produces:
  ```ts
  // src/hooks/useMutationQueue.ts
  export type { ExecutorFactory, MutationErrorInfo, QueuedMutation } from "@/src/sync/engine";
  export function useMutationQueue(listId: string, getJwt: () => string | null, executorFactory?: ExecutorFactory, onMutationError?: (info: MutationErrorInfo) => void, onMutationSuccess?: (m: QueuedMutation, result: unknown) => void, onAuthNeeded?: () => void /* EXTENSION */): { addMutation: (m: { id: string; type: string; payload: Record<string, unknown> }) => void; flushQueue: () => Promise<void>; pendingFields: (itemId: string) => Set<string> };
  // src/utils/executor-factory.ts
  export const createExecutorFactory: () => ExecutorFactory; // + case "restore": PATCH /api/lists/<listId>/items { itemId, deleted_at: null }, verb "Restore"; create and recycle resolve with items[0] ?? null
  // src/sync/overlay.ts
  export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData;
  // src/hooks/useItemHandlers.ts / useListDragDrop.ts
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown> }) => void; // param type; useListDragDrop no longer takes jwtRef
  // payloads: toggle { listId, itemId, completed, at }, skip { listId, itemId, skipped, at }, order { listId, itemId, ordered, at } (at = tap time, ISO)
  ```

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H3 (hook/page) | `src/hooks/useMutationQueue.ts:190-197` mount flush; `app/list/[id]/page.tsx:164-166` is the only load path, and nothing flushes once a JWT exists | The adapter never flushes on mount. The page flushes in an effect keyed on `jwt`. | `mutation-queue-hook.test.ts` (3 tests); `list-sync-wiring.test.ts` › "flushes the list's saved changes once a token exists, not before (H3)" |
| H4 / H5 (one path) | Two request builders per type (`useItemHandlers.ts` inline closures at :104-127, :165-177, :221-233, :271-282, :299-311, :326-338, :390-402, :425-437, :457-469, :493-505, :555-566; `useListDragDrop.ts:106-118, :127-143`) bypass any engine ordering | Every `addMutation` call carries only `{ id, type, payload }`; the engine runs executor-factory for both online and replay | `single-executor.test.ts`; `mutation-request-parity.test.ts`; `restore-skipped-flow.test.ts` › "an item still waiting for its offline create is restored through its own skip, sent with the real id after the create" |
| H5 (create response) | `useItemHandlers.ts:117-124` replaces the temp row with `created[0]` wholesale, wiping a tick/edit made before the create answered | Page `onMutationSuccess` for "create" swaps the row with `overlayPending(row, local, engine.pendingFields(row.id))` | `list-sync-wiring.test.ts` › "a landed create keeps the tick made on the item before its create answered (H5)" |
| H19 (client) | `useItemHandlers.ts:216-234, 319-342, 420-438` payloads carry no action time; `executor-factory.ts:37, 92, 106` bodies carry none | Handlers put `at` (tap time, also used for the optimistic timestamp) in toggle/skip/order payloads; the factory sends `at`, falling back to `QueuedMutation.timestamp` for entries saved before this change | `tap-time.test.ts` (3 tests); `executor-factory.test.ts` › "createExecutorFactory - tap time" (4 tests) |
| (spec §3) `restore` type | no queued restore exists | `case "restore"` | `executor-factory.test.ts` › "createExecutorFactory - restore"; parity "restore" |

- [ ] **Step 1: Update the executor-factory test.** The stale-toggle body now includes `at`. Add the tap-time, server-row, restore and reorder cases (the reorder request was asserted in the drag-hook test, which no longer sends anything):

Current (1):

```ts
import type { QueuedMutation } from "@/src/utils/mutation-queue";

// Every mutation type enqueued by useItemHandlers must have a factory case,
// otherwise offline replay (which rebuilds executors via this factory) silently
// drops the mutation. Keep this list in sync with useItemHandlers.ts.
```

Replace with:

```ts
import type { QueuedMutation } from "@/src/sync/engine";

// The factory is the only executor: the sync engine sends every change through it, online
// and on replay, and drops (with a toast) a type it has no case for. Every type queued by
// useItemHandlers / useListDragDrop needs a case (single-executor.test.ts checks the call
// sites against this file).
```

Current (2):

```ts
  "set-category",
```

Replace with:

```ts
  "set-category",
  "restore",
```

Current (3):

```ts
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", completed: true });
```

Replace with:

```ts
    // Saved before `at` existed: the tap time is the time it was queued.
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", completed: true, at: "1970-01-01T00:00:00.000Z" });
  });
});

// Toggle, skip and order send the tap time, so a change synced hours later is stamped with
// the time the user made it (the server clamps it to the last 24 hours).
describe("createExecutorFactory - tap time", () => {
  const factory = createExecutorFactory();
  const AT = "2026-10-29T08:15:00.000Z";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["toggle", { completed: true }],
    ["skip", { skipped: true }],
    ["order", { ordered: false }],
  ])("%s sends the payload's tap time", async (type, fields) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type, payload: { listId: "l1", itemId: "i1", ...fields, at: AT }, timestamp: Date.parse("2026-10-29T11:00:00.000Z") }, () => "jwt")!();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ itemId: "i1", ...fields, at: AT });
  });

  it("falls back to the time it was queued for an entry saved without one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type: "skip", payload: { listId: "l1", itemId: "i1", skipped: true }, timestamp: Date.parse(AT) }, () => "jwt")!();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).at).toBe(AT);
  });
});

// The engine records a create's real id from what its executor resolves with, and the
// page swaps the temp row for that row.
describe("createExecutorFactory - server rows", () => {
  const factory = createExecutorFactory();
  const row = { id: "00000000-0000-4000-8000-000000000001", text: "milk", position: 7 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["create", { text: "milk", idempotencyKey: "k", position: 7, tempId: "temp-1" }],
    ["recycle", { text: "milk", recycleId: row.id }],
  ])("%s resolves with the server's row", async (type, fields) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ items: [{ ...row, recycled: type === "recycle" }] }) }));

    await expect(factory({ id: "m", type, payload: { listId: "l1", ...fields }, timestamp: 0 }, () => "jwt")!()).resolves.toMatchObject(row);
  });

  it("create resolves with null when the server created nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ items: [] }) }));

    await expect(factory({ id: "m", type: "create", payload: { listId: "l1", text: "milk", tempId: "temp-1" }, timestamp: 0 }, () => "jwt")!()).resolves.toBeNull();
  });
});

// Undo of an item delete is a queued "restore", so it lands after the delete it undoes.
describe("createExecutorFactory - restore", () => {
  const factory = createExecutorFactory();
  const mutation: QueuedMutation = { id: "m", type: "restore", payload: { listId: "l1", itemId: "i1" }, timestamp: 0 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the item back with deleted_at null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory(mutation, () => "jwt")!();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ itemId: "i1", deleted_at: null });
  });

  it("throws with the HTTP status when the server rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(factory(mutation, () => "jwt")!()).rejects.toThrow(/: 503$/);
```

Current (4):

```ts

// Dropping an item under another category while offline must still reach the
```

Replace with:

```ts

// A drag's new order, sent by the sync engine once every earlier change has landed.
describe("createExecutorFactory - reorder", () => {
  const factory = createExecutorFactory();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the order to the list's reorder endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await factory({ id: "m", type: "reorder", payload: { listId: "l1", orderedIds: ["a", "b"] }, timestamp: 0 }, () => "jwt")!();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items/reorder");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ orderedIds: ["a", "b"] });
  });
});

// Dropping an item under another category while offline must still reach the
```

- [ ] **Step 2: Replace `__tests__/unit/mutation-request-parity.test.ts`** with this whole file. It no longer compares two request builders by source inspection, because there is only one now. It runs each type online and after a reload through the real engine and factory:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getSyncEngine, resetSyncEngines, type QueuedMutation } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

// A change made online and the same change replayed after a reload must send the same
// request. This already broke in production (5f3dd51) when each change type had two request
// builders, an inline one for online and executor-factory for replay. Now the sync engine
// sends every change through executor-factory; this runs each type both ways through the
// real engine and factory and compares what reaches fetch.

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const AT = "2026-10-29T08:00:00.000Z";

// One representative payload per executor-factory case.
const SAMPLES: Record<string, Record<string, unknown>> = {
  create: { text: "milk", position: 5, idempotencyKey: "k1", tempId: "temp-1" },
  toggle: { itemId: A, completed: true, at: AT },
  delete: { itemId: A },
  edit: { itemId: A, text: "oat milk" },
  reorder: { orderedIds: [A, B] },
  skip: { itemId: A, skipped: true, at: AT },
  order: { itemId: A, ordered: true, at: AT },
  "set-recurring": { itemId: A, recurring: true },
  "restore-recurring": { itemId: A },
  recycle: { text: "milk", recycleId: A },
  "unskip-all": { itemIds: [A, B] },
  "set-category": { itemId: A, categoryId: B },
  restore: { itemId: A },
};

type Sent = { url: string; method: string; auth: string; body: unknown };

const storage = new Map<string, string>();
let sent: Sent[] = [];

beforeEach(() => {
  resetSyncEngines();
  storage.clear();
  sent = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ items: [{ id: B }] }) };
  }));
});

afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function attach() {
  const engine = getSyncEngine("L");
  engine.attach({ getJwt: () => "jwt", executorFactory: createExecutorFactory() });
  return engine;
}

async function online(type: string): Promise<Sent[]> {
  sent = [];
  attach().add({ id: "m1", type, payload: { listId: "L", ...SAMPLES[type] } });
  await settle();
  return sent;
}

async function afterReload(type: string): Promise<Sent[]> {
  resetSyncEngines();
  sent = [];
  const saved: QueuedMutation = { id: "m1", type, payload: { listId: "L", ...SAMPLES[type] }, timestamp: Date.now() };
  storage.set("mutation_queue:L", JSON.stringify([saved]));
  await attach().flush();
  return sent;
}

describe("mutation request parity: online vs. replay", () => {
  it("has a sample for every executor-factory case", () => {
    const source = readFileSync(resolve(process.cwd(), "src/utils/executor-factory.ts"), "utf8");
    const cases = [...source.matchAll(/case\s*"([a-zA-Z-]+)":/g)].map((m) => m[1]).sort();
    expect(cases.length).toBeGreaterThan(0);
    expect(Object.keys(SAMPLES).sort()).toEqual(cases);
  });

  for (const type of Object.keys(SAMPLES)) {
    it(`"${type}": online and after a reload it sends the same request`, async () => {
      const first = await online(type);
      const replayed = await afterReload(type);

      expect(first).toHaveLength(1);
      expect(first[0].auth).toBe("Bearer jwt");
      expect(replayed).toEqual(first);
    });
  }
});
```

- [ ] **Step 3: Create `__tests__/unit/single-executor.test.ts`**, the guard that no inline `execute` closures remain:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Every queued change is sent by executor-factory through the sync engine, online and on
// replay. An inline request inside an addMutation call would be a second request builder
// for that type, the drift that once made a tap do one thing online and another after a
// reload (5f3dd51). Source inspection: these hooks can't run their handlers in node without
// a page around them, and what matters is that the call sites carry no request.

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const QUEUING_FILES = ["src/hooks/useItemHandlers.ts", "src/hooks/useListDragDrop.ts"];

// The object literal passed to each `addMutation({ ... })` call, brace-matched (strings and
// template literals are skipped so their braces don't count).
function addMutationArgs(source: string): string[] {
  const args: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("addMutation({", from);
    if (at === -1) return args;
    const open = at + "addMutation(".length;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "`" || c === '"' || c === "'") {
        for (i++; i < source.length && source[i] !== c; i += source[i] === "\\" ? 2 : 1);
        continue;
      }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) break;
    }
    args.push(source.slice(open, i + 1));
    from = i + 1;
  }
}

const factoryCases = new Set(
  [...read("src/utils/executor-factory.ts").matchAll(/case\s*"([a-zA-Z-]+)":/g)].map((m) => m[1])
);

describe("one executor per change", () => {
  for (const file of QUEUING_FILES) {
    const calls = addMutationArgs(read(file));

    it(`${file}: finds its addMutation calls`, () => {
      expect(calls.length).toBeGreaterThan(0);
    });

    it(`${file}: no addMutation call carries its own request`, () => {
      for (const call of calls) {
        expect(call, call).not.toMatch(/\bexecute\b/);
        expect(call, call).not.toMatch(/\bfetch\(/);
      }
    });

    it(`${file}: every queued type has an executor-factory case`, () => {
      for (const call of calls) {
        const type = call.match(/type:\s*"([a-zA-Z-]+)"/)?.[1];
        expect(type, call).toBeDefined();
        expect(factoryCases.has(type!), `no executor-factory case for "${type}"`).toBe(true);
      }
    });
  }
});
```

- [ ] **Step 4: Create `__tests__/unit/mutation-queue-hook.test.ts`:**

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useMutationQueue over the real sync engine and executor factory, with a
// slot-based stand-in for React (pattern: restore-skipped-flow.test.ts): refs and memoized
// callbacks persist across renders, effects follow their deps and run during render.
type Slot = { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      if (s && typeof s.cleanup === "function") s.cleanup();
      R.slots[i] = { deps, cleanup: fn() };
    },
  };
});

import { useMutationQueue } from "@/src/hooks/useMutationQueue";
import { resetSyncEngines } from "@/src/sync/engine";

const ITEM = "00000000-0000-4000-8000-000000000001";
const storage = new Map<string, string>();
const jwt = { current: null as string | null };
const getJwt = () => jwt.current;
let fetchMock: ReturnType<typeof vi.fn>;

const saved = () => JSON.parse(storage.get("mutation_queue:L") ?? "[]") as { id: string }[];
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
// The list page mounting: two hook instances, as two components on one page would have.
const mount = () => {
  R.slots = [];
  R.i = 0;
  return [useMutationQueue("L", getJwt), useMutationQueue("L", getJwt)];
};

beforeEach(() => {
  resetSyncEngines();
  storage.clear();
  jwt.current = null;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMutationQueue over the sync engine (H3)", () => {
  it("mounting before the token exists sends nothing and keeps every saved change", async () => {
    storage.set(
      "mutation_queue:L",
      JSON.stringify([{ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true }, timestamp: Date.now() }])
    );
    const [q] = mount();
    await q.flushQueue();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved().map((m) => m.id)).toEqual(["m1"]);

    jwt.current = "jwt";
    await q.flushQueue();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer jwt");
    expect(saved()).toEqual([]);
  });

  it("does not flush on mount: replay waits for the page's flush", async () => {
    jwt.current = "jwt";
    storage.set(
      "mutation_queue:L",
      JSON.stringify([{ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true }, timestamp: Date.now() }])
    );
    const [q] = mount();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await q.flushQueue();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a change made before the token exists is sent once, by the flush after it arrives", async () => {
    const [a, b] = mount();
    a.addMutation({ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true, at: "2026-10-29T08:00:00.000Z" } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    jwt.current = "jwt";
    await Promise.all([a.flushQueue(), b.flushQueue()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(saved()).toEqual([]);
  });
});
```

- [ ] **Step 5: Create `__tests__/unit/tap-time.test.ts`:**

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@/src/types/telegram", () => ({ getTelegramWebApp: () => null }));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import type { ItemData } from "@/src/types";

// Toggle, skip and order carry the tap time (`at`), which the server stamps completed_at /
// skipped_at / ordered_at with, so a change that syncs hours later keeps the time it was made
// (H19). The screen shows the same time.
const TAP = "2026-10-29T08:15:00.000Z";

function world() {
  let items: ItemData[] = [
    {
      id: "i1", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
      recurring: false, position: 1, created_by: null, creator_name: null, edited_by: null, editor_name: null,
    },
  ];
  const queued: { type: string; payload: Record<string, unknown> }[] = [];
  const h = useItemHandlers({
    listId: "L",
    jwtRef: { current: "jwt" },
    userId: "u",
    items,
    setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
    addMutation: (m) => queued.push(m),
    setUndoAction: () => {},
    setDuplicateWarning: () => {},
    setReminderToast: () => {},
    setErrorToast: () => {},
    t: (key) => key,
  });
  return { h, queued, item: () => items[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TAP));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("changes carry the time of the tap (H19)", () => {
  it("a tick sends the tap time, and shows it, even when its animation ends later", async () => {
    const w = world();
    const ticking = w.h.handleToggle("i1", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;

    expect(w.queued).toEqual([{ id: expect.any(String), type: "toggle", payload: { listId: "L", itemId: "i1", completed: true, at: TAP } }]);
    expect(w.item().completed_at).toBe(TAP);
  });

  it("a skip sends the tap time", () => {
    const w = world();
    w.h.handleSkip("i1", true);

    expect(w.queued[0].payload).toEqual({ listId: "L", itemId: "i1", skipped: true, at: TAP });
    expect(w.item().skipped_at).toBe(TAP);
  });

  it("marking on the way sends the tap time", () => {
    const w = world();
    w.h.handleOrder("i1", true);

    expect(w.queued[0].payload).toEqual({ listId: "L", itemId: "i1", ordered: true, at: TAP });
    expect(w.item().ordered_at).toBe(TAP);
  });
});
```

- [ ] **Step 6: Create `__tests__/unit/list-sync-wiring.test.ts`.** It renders the T1 page at `@/app/(app)/list/[id]/page`. If T1's page reads more `useTelegram()` fields during render than this mock gives, add them with neutral values (`null`, `false`, `() => {}`):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import type { ItemData } from "@/src/types";

// Calls the real list page as a plain function with slot-based stand-ins for React's hooks:
// state persists across renders, effects are recorded and run by the test. The data hooks
// are stubbed; useMutationQueue records what the page hands the sync engine.
type Slot = { value?: unknown };
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = R.slots[i];
    const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
    return [slot.value, set];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: fn() };
    return R.slots[i].value;
  },
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const S = vi.hoisted(() => ({
  jwt: null as string | null,
  items: [] as ItemData[],
  requestTokenRefresh: () => {},
  flushQueue: null as unknown as ReturnType<typeof vi.fn>,
  refreshItems: null as unknown as ReturnType<typeof vi.fn>,
  queueArgs: [] as unknown[],
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwt: S.jwt,
    jwtRef: { current: S.jwt },
    requestTokenRefresh: S.requestTokenRefresh,
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {},
    items: S.items,
    setItems: (u: ItemData[] | ((p: ItemData[]) => ItemData[])) => { S.items = typeof u === "function" ? u(S.items) : u; },
    loading: false, error: false, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: async () => {}, fetchItems: async () => {}, refreshItems: S.refreshItems, retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: (...args: unknown[]) => {
    S.queueArgs = args;
    return { addMutation: () => {}, flushQueue: S.flushQueue, pendingFields: () => new Set() };
  },
}));
const ENGINE = vi.hoisted(() => ({ pending: new Set<string>() }));
vi.mock("@/src/sync/engine", () => ({ getSyncEngine: () => ({ pendingFields: () => ENGINE.pending }) }));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => ({ resubscribe: () => {} }) }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/ItemRow", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// Renders the component that calls the page's hooks: the default export itself, or the one
// it wraps.
function render() {
  R.i = 0;
  R.effects = [];
  const out = (ListPage as () => El)();
  if (R.i > 0) return;
  const child = out.props.children as El | undefined;
  const inner = (child && typeof child.type === "function" ? child.type : out.type) as () => El;
  R.i = 0;
  R.effects = [];
  inner();
}
const runEffects = () => {
  for (const e of R.effects) e.fn();
};
const onSuccess = () => S.queueArgs[4] as (m: unknown, result: unknown) => void;

const item = (over: Partial<ItemData> & { id: string }): ItemData => ({
  text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
  recurring: false, position: 1, created_by: "u1", creator_name: null, edited_by: null, editor_name: null, ...over,
});

beforeEach(() => {
  R.slots = [];
  S.jwt = null;
  S.items = [];
  S.queueArgs = [];
  S.flushQueue = vi.fn(async () => {});
  S.refreshItems = vi.fn(async () => {});
  ENGINE.pending = new Set();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the list page and its sync engine", () => {
  it("flushes the list's saved changes once a token exists, not before (H3)", () => {
    render();
    runEffects();
    expect(S.flushQueue).not.toHaveBeenCalled();

    S.jwt = "jwt";
    render();
    runEffects();
    expect(S.flushQueue).toHaveBeenCalledOnce();
  });

  it("a landed create keeps the tick made on the item before its create answered (H5)", () => {
    S.items = [item({ id: "temp-1", text: "milk", completed: true, completed_at: "2026-10-29T08:00:00.000Z", position: 99, _pending: true })];
    ENGINE.pending = new Set(["completed", "completed_at"]);
    render();

    onSuccess()(
      { id: "m1", type: "create", payload: { listId: "L", tempId: "temp-1", text: "milk" }, timestamp: 0 },
      item({ id: "real-1", text: "milk", position: 7, category_id: "dairy" })
    );

    expect(S.items).toEqual([
      expect.objectContaining({
        id: "real-1", text: "milk", position: 7, category_id: "dairy",
        completed: true, completed_at: "2026-10-29T08:00:00.000Z", _pending: false,
      }),
    ]);
  });
});
```

- [ ] **Step 7: Update `__tests__/unit/restore-skipped-flow.test.ts`.** The engine is module-level, so a "reopen" must forget it: `makeQueue` and the hooks call `resetSyncEngines()`. The fake server answers a create. The temp-item test seeded a `temp-` item with no create in the queue, which the engine now (correctly) drops as orphaned. It is rewritten to the real flow: the create was saved by a previous session, the skip waits behind it, and Restore all (a barrier) waits behind both.

Current (1):

```ts
import { createExecutorFactory } from "@/src/utils/executor-factory";
```

Replace with:

```ts
import { createExecutorFactory } from "@/src/utils/executor-factory";
import { resetSyncEngines } from "@/src/sync/engine";
```

Current (2):

```ts
// A grocery list with milk and eggs under Not available and bread active.
function world(opts: { extraItems?: ItemData[] } = {}) {
  const server = new Map<string, Row>([
    ["milk", { id: "milk", skipped_at: SKIPPED_AT }],
    ["eggs", { id: "eggs", skipped_at: SKIPPED_AT }],
    ["bread", { id: "bread", skipped_at: null }],
  ]);
  const storage = new Map<string, string>();
```

Replace with:

```ts
// A grocery list with milk and eggs under Not available and bread active. `saved` is the
// list's offline queue as a previous session left it.
function world(opts: { extraItems?: ItemData[]; saved?: unknown[] } = {}) {
  const server = new Map<string, Row>([
    ["milk", { id: "milk", skipped_at: SKIPPED_AT }],
    ["eggs", { id: "eggs", skipped_at: SKIPPED_AT }],
    ["bread", { id: "bread", skipped_at: null }],
  ]);
  const storage = new Map<string, string>();
  if (opts.saved) storage.set("mutation_queue:L", JSON.stringify(opts.saved));
```

Current (3):

```ts
  // Per-request behaviors, consumed in order; default "ok". Keys: "unskip-all" or "PATCH <id>".
```

Replace with:

```ts
  // Per-request behaviors, consumed in order; default "ok". Keys: "unskip-all", "PATCH <id>" or "POST create".
```

Current (4):

```ts
    const key = url.endsWith("/items/unskip-all") ? "unskip-all" : `${init.method} ${body.itemId}`;
    const behavior = behaviors.get(key)?.shift() ?? "ok";
    if (behavior === "neterr") { log.push(`${key} neterr`); throw new TypeError("Failed to fetch"); }
    if (behavior === 500) { log.push(`${key} 500`); return { ok: false, status: 500, json: async () => ({}) }; }
    if (behavior === "hold") await new Promise<void>((resolve) => held.set(key, resolve));
```

Replace with:

```ts
    const key = url.endsWith("/items/unskip-all")
      ? "unskip-all"
      : init.method === "POST"
        ? "POST create"
        : `${init.method} ${body.itemId}`;
    const behavior = behaviors.get(key)?.shift() ?? "ok";
    if (behavior === "neterr") { log.push(`${key} neterr`); throw new TypeError("Failed to fetch"); }
    if (behavior === 500) { log.push(`${key} 500`); return { ok: false, status: 500, json: async () => ({}) }; }
    if (behavior === "hold") await new Promise<void>((resolve) => held.set(key, resolve));
    if (key === "POST create") {
      // The server names the new row after its text.
      server.set(body.text, { id: body.text, skipped_at: null });
      log.push(`create ${body.text}`);
      return { ok: true, status: 201, json: async () => ({ items: [{ ...toItem(server.get(body.text)!), text: body.text }] }) };
    }
```

Current (5):

```ts
  // Reopening the app: a fresh mount over the same storage.
  const makeQueue = () => {
```

Replace with:

```ts
  // Reopening the app: a fresh mount over the same storage, with no engine in memory.
  const makeQueue = () => {
    resetSyncEngines();
```

Current (6):

```ts
beforeEach(() => {
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
```

Replace with:

```ts
beforeEach(() => {
  resetSyncEngines();
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetSyncEngines();
```

Current (7):

```ts
  it("an item still waiting for its offline create is restored through its own skip mutation, queued at tap time", async () => {
    const pending = { ...toItem({ id: "temp-1-0.5", skipped_at: SKIPPED_AT }), _pending: true };
    const w = world({ extraItems: [pending] });
    w.when("PATCH temp-1-0.5", "neterr");
    w.h.handleRestoreSkipped();
    expect(w.clientState("temp-1-0.5")).toEqual({ "temp-1-0.5": "active" });
    await settle();

    expect(w.log).toContain("unskip-all milk,eggs");
    // Queued behind its create, so the queue can swap in the real id before sending.
    expect(w.queued()).toEqual(["skip"]);
```

Replace with:

```ts
  it("an item still waiting for its offline create is restored through its own skip, sent with the real id after the create", async () => {
    const pending = { ...toItem({ id: "temp-1-0.5", skipped_at: SKIPPED_AT }), text: "rice", _pending: true };
    const create = {
      id: "c1",
      type: "create",
      payload: { listId: "L", text: "rice", position: 1, idempotencyKey: "c1", tempId: "temp-1-0.5" },
      timestamp: Date.now(),
    };
    const w = world({ extraItems: [pending], saved: [create] });
    w.when("POST create", "neterr");
    w.h.handleRestoreSkipped();
    expect(w.clientState("temp-1-0.5")).toEqual({ "temp-1-0.5": "active" });
    await settle();

    // Nothing goes out with the temp id: the skip waits behind its create, and Restore all
    // (a list-wide change) waits behind both.
    expect(w.log).toEqual(["POST create neterr"]);
    expect(w.queued()).toEqual(["create", "skip", "unskip-all"]);

    await w.q.flushQueue();
    await settle();

    expect(w.log).toEqual(["POST create neterr", "create rice", "PATCH rice skipped=false", "unskip-all milk,eggs"]);
    expect(w.serverState("milk", "eggs", "rice")).toEqual({ milk: "active", eggs: "active", rice: "active" });
    expect(w.queued()).toEqual([]);
```

- [ ] **Step 8: Update `__tests__/unit/grouped-drag-hook.test.ts`.** The hook no longer takes `jwtRef` or carries `execute`. The two tests that called `execute()` ("PATCHes the item with its new category, and holds the drag lock until the reorder lands" and "throws when the server refuses the category…") encode the old inline executor and the old lock. They become one test: the hook queues only `{ id, type, payload }` and ends the drag at the drop. The request shapes stay covered by `executor-factory.test.ts` (set-category, plus the new reorder test) and the parity test.

Current (1):

```ts
type Queued = { type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> };
```

Replace with:

```ts
type Queued = { id: string; type: string; payload: Record<string, unknown> };
```

Current (2):

```ts
  const jwtRef = { current: "jwt" };
  const groups = () => {
    const active = items.filter(isActiveItem).sort((a, b) => b.position - a.position);
    return groupByCategory(active, categories, "en", "Sorting…");
  };

  // The list page re-renders with the latest items and categories.
  const render = (): Hook => {
    R.i = 0;
    return useListDragDrop({ items, setItems, addMutation, listId: "L", jwtRef, groups: grouped ? groups() : null });
```

Replace with:

```ts
  const groups = () => {
    const active = items.filter(isActiveItem).sort((a, b) => b.position - a.position);
    return groupByCategory(active, categories, "en", "Sorting…");
  };

  // The list page re-renders with the latest items and categories.
  const render = (): Hook => {
    R.i = 0;
    return useListDragDrop({ items, setItems, addMutation, listId: "L", groups: grouped ? groups() : null });
```

Current (3):

```ts
  it("PATCHes the item with its new category, and holds the drag lock until the reorder lands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const w = world();
    const h = w.render();
    start(h);
    end(h, "apples", { group: "dairy", index: 1 });
    const [setCategory, reorder] = w.queued();

    await setCategory.execute();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/L/items");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({ itemId: "apples", categoryId: "dairy" });
    expect(h.isDraggingRef.current).toBe(true);

    await reorder.execute();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/lists/L/items/reorder");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      orderedIds: ["milk", "bananas", "cheese", "apples", "yogurt"],
    });
    expect(h.isDraggingRef.current).toBe(false);
  });

  it("throws when the server refuses the category, so the queue retries it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const w = world();
    const h = w.render();
    start(h);
    end(h, "apples", { group: "dairy", index: 1 });

    await expect(w.queued()[0].execute()).rejects.toThrow(/500/);
```

Replace with:

```ts
  it("queues the changes for the sync engine to send, and ends the drag at the drop", () => {
    // The requests themselves are executor-factory's (executor-factory.test.ts). Until the
    // reorder lands, the new positions are the engine's pending fields.
    const w = world();
    const h = w.render();
    start(h);
    expect(h.isDraggingRef.current).toBe(true);
    end(h, "apples", { group: "dairy", index: 1 });

    expect(w.queued().map((m) => Object.keys(m).sort())).toEqual([
      ["id", "payload", "type"],
      ["id", "payload", "type"],
    ]);
    expect(h.isDraggingRef.current).toBe(false);
```

- [ ] **Step 9: Run and watch them fail.**

  Run: `npx vitest run __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/single-executor.test.ts __tests__/unit/mutation-queue-hook.test.ts __tests__/unit/tap-time.test.ts __tests__/unit/list-sync-wiring.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/grouped-drag-hook.test.ts`

  Expected failures (the rest pass):
  - `executor-factory.test.ts`:
    - "returns a non-null executor for \"restore\" mutations"
    - "replays a stale queued toggle…" (the body has no `at`)
    - all 4 "tap time" tests
    - all 3 "server rows" tests (create resolves with the id string, recycle with undefined)
    - both "restore" tests
  - `mutation-request-parity.test.ts`: "has a sample for every executor-factory case" and "\"restore\": …". The other per-type parity tests already pass, because the old factory runs on both sides.
  - `single-executor.test.ts`: "no addMutation call carries its own request", for both files.
  - `mutation-queue-hook.test.ts`: all 3. The old hook's mount flush drops or sends, and its `flushQueue` ignores the engine.
  - `tap-time.test.ts`: all 3 (`at` missing).
  - `list-sync-wiring.test.ts`: "flushes … once a token exists" and "a landed create keeps the tick…" (`S.queueArgs[4]` is undefined).
  - `restore-skipped-flow.test.ts`: "an item still waiting for its offline create…".
  - `grouped-drag-hook.test.ts`: "queues the changes for the sync engine to send, and ends the drag at the drop". (Vitest does not typecheck. Until Step 13, `npx tsc --noEmit` also reports that this test no longer passes `jwtRef`.)

- [ ] **Step 10: Executor factory.** In `src/utils/executor-factory.ts`:

Current (1):

```ts
import type { ExecutorFactory } from "@/src/hooks/useMutationQueue";
import type { QueuedMutation } from "@/src/utils/mutation-queue";
```

Replace with:

```ts
import type { ExecutorFactory, QueuedMutation } from "@/src/sync/engine";

// The one request builder per change type: the sync engine runs every change through it,
// online and on replay. Tap time for toggle / skip / order: the payload's `at`, or the
// queue time for an entry saved before `at` existed.
const tapTime = (mutation: QueuedMutation): string =>
  typeof mutation.payload.at === "string" ? mutation.payload.at : new Date(mutation.timestamp).toISOString();
```

Current (2):

```ts
          return created?.[0]?.id as string | undefined;
```

Replace with:

```ts
          return created?.[0] ?? null;
```

Current (3):

```ts
            body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed }),
```

Replace with:

```ts
            body: JSON.stringify({ itemId: payload.itemId, completed: payload.completed, at: tapTime(mutation) }),
```

Current (4):

```ts
            body: JSON.stringify({ itemId: payload.itemId, skipped: payload.skipped }),
```

Replace with:

```ts
            body: JSON.stringify({ itemId: payload.itemId, skipped: payload.skipped, at: tapTime(mutation) }),
```

Current (5):

```ts
            body: JSON.stringify({ itemId: payload.itemId, ordered: payload.ordered }),
```

Replace with:

```ts
            body: JSON.stringify({ itemId: payload.itemId, ordered: payload.ordered, at: tapTime(mutation) }),
```

Current (6):

```ts
          if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
```

Replace with:

```ts
          if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
          const { items: recycled } = await res.json();
          return recycled?.[0] ?? null;
```

Current (7):

```ts
        };
      default:
```

Replace with:

```ts
        };
      case "restore":
        // Undo of an item delete: queued behind the delete, so it always lands after it.
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, deleted_at: null }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore failed: ${res.status}`);
        };
      default:
```

- [ ] **Step 11: Replace `src/hooks/useMutationQueue.ts`** with this whole file:

```ts
"use client";

import { useRef, useCallback, useEffect } from "react";
import {
  getSyncEngine,
  type ExecutorFactory,
  type MutationErrorInfo,
  type QueuedMutation,
} from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

export type { ExecutorFactory, MutationErrorInfo, QueuedMutation } from "@/src/sync/engine";

const defaultExecutorFactory = createExecutorFactory();

/**
 * The list page's handle on its list's sync engine (src/sync/engine.ts). Every change goes
 * through addMutation and is sent by the executor factory, online and on replay. Nothing is
 * flushed here on mount: the page flushes once a JWT exists, and the provider flushes every
 * list after auth.
 */
export function useMutationQueue(
  listId: string,
  getJwt: () => string | null,
  executorFactory?: ExecutorFactory,
  onMutationError?: (info: MutationErrorInfo) => void,
  onMutationSuccess?: (m: QueuedMutation, result: unknown) => void,
  onAuthNeeded?: () => void
) {
  // Latest callbacks, read when the engine calls back, so a re-render never re-attaches.
  const latest = useRef({ getJwt, executorFactory, onMutationError, onMutationSuccess, onAuthNeeded });
  useEffect(() => {
    latest.current = { getJwt, executorFactory, onMutationError, onMutationSuccess, onAuthNeeded };
  });

  useEffect(
    () =>
      getSyncEngine(listId).attach({
        getJwt: () => latest.current.getJwt(),
        executorFactory: (m, jwt) => (latest.current.executorFactory ?? defaultExecutorFactory)(m, jwt),
        onError: (info) => latest.current.onMutationError?.(info),
        onSuccess: (m, result) => latest.current.onMutationSuccess?.(m, result),
        onAuthNeeded: () => latest.current.onAuthNeeded?.(),
      }),
    [listId]
  );

  const addMutation = useCallback(
    (mutation: { id: string; type: string; payload: Record<string, unknown> }) => getSyncEngine(listId).add(mutation),
    [listId]
  );
  const flushQueue = useCallback(() => getSyncEngine(listId).flush(), [listId]);
  const pendingFields = useCallback((itemId: string) => getSyncEngine(listId).pendingFields(itemId), [listId]);

  return { addMutation, flushQueue, pendingFields };
}
```

- [ ] **Step 12: Item handlers.** In `src/hooks/useItemHandlers.ts`, apply these pairs in order. They remove every inline `execute` (and the `jwtRef` deps that only those used), remove the create follow-up (the page does it now), and capture the tap time `at` once per toggle/skip/order for both the optimistic value and the payload. `enqueueSkip` gains an `at` parameter.

Current (1):

```ts
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> }) => void;
```

Replace with:

```ts
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown> }) => void;
```

Current (2):

```ts
      }, 300);

      addMutation({
        id: mutId,
        type: "create",
        payload: { listId, text, position, idempotencyKey: mutId, tempId },
        execute: async () => {
          const currentJwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, idempotencyKey: mutId, position }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Create failed: ${res.status}`);
          const { items: created } = await res.json();
          if (created?.[0]) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === tempId
                  ? { ...created[0], creator_name: null, editor_name: null, _pending: false }
                  : i
              )
            );
            return created[0].id;
          }
        },
      });
    },
    [jwtRef, listId, addMutation, userId, setItems]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      // No JWT guard here — items are added optimistically and queued.
      // The executor reads jwtRef.current at execution time (after reconnect).
```

Replace with:

```ts
      }, 300);

      // The page's create success handler swaps in the server's row.
      addMutation({
        id: mutId,
        type: "create",
        payload: { listId, text, position, idempotencyKey: mutId, tempId },
      });
    },
    [listId, addMutation, userId, setItems]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      // No JWT guard here — items are added optimistically and queued.
      // The sync engine sends them once a JWT exists.
```

Current (3), delete these lines (no replacement):

```ts
          execute: async () => {
            const currentJwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text, recycleId }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Recycle failed: ${res.status}`);
          },
```

Current (4):

```ts
    [jwtRef, listId, addMutation, addSingleItem, items, t, userId, setItems, setDuplicateWarning]
  );

  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
```

Replace with:

```ts
    [listId, addMutation, addSingleItem, items, t, userId, setItems, setDuplicateWarning]
  );

  const handleToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      // Tap time: the server stamps completed_at with it, even when the change syncs later.
      const at = new Date().toISOString();
```

Current (5):

```ts
                completed_at: completed ? new Date().toISOString() : null,
```

Replace with:

```ts
                completed_at: completed ? at : null,
```

Current (6):

```ts
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

  const handleDelete = useCallback(
```

Replace with:

```ts
        payload: { listId, itemId, completed, at },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleDelete = useCallback(
```

Current (7):

```ts
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(
            `/api/lists/${listId}/items?itemId=${itemId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${jwt}` },
              keepalive: true,
            }
          );
          if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );
```

Replace with:

```ts
      });
    },
    [listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );
```

Current (8):

```ts
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, text: newText }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, userId, setItems]
  );

  // Server side of a skip/unskip. Shared by handleSkip and Restore all, which uses
  // it for items still waiting for their offline create.
  const enqueueSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "skip",
        payload: { listId, itemId, skipped },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, skipped }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Skip failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation]
  );

  const handleSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      // Optimistic update
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, skipped_at: skipped ? new Date().toISOString() : null }
            : i
        )
      );

      enqueueSkip(itemId, skipped);
```

Replace with:

```ts
      });
    },
    [listId, addMutation, userId, setItems]
  );

  // Server side of a skip/unskip. Shared by handleSkip and Restore all, which uses
  // it for items still waiting for their offline create.
  // `at` is the tap time the server stamps skipped_at with.
  const enqueueSkip = useCallback(
    (itemId: string, skipped: boolean, at: string) => {
      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "skip",
        payload: { listId, itemId, skipped, at },
      });
    },
    [listId, addMutation]
  );

  const handleSkip = useCallback(
    (itemId: string, skipped: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      const at = new Date().toISOString();

      // Optimistic update
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, skipped_at: skipped ? at : null }
            : i
        )
      );

      enqueueSkip(itemId, skipped, at);
```

Current (9):

```ts
    // restore anything skipped after this tap. An item still waiting for its offline
    // create has a temp- id the server doesn't know; its own skip mutation, queued
    // behind the create, restores it once the queue swaps in the real id.
    const itemIds: string[] = [];
    for (const id of affectedIds) {
      if (id.startsWith("temp-")) enqueueSkip(id, false);
      else itemIds.push(id);
    }
    if (itemIds.length === 0) return;

    addMutation({
      id: genMutId(),
      type: "unskip-all",
      payload: { listId, itemIds },
      execute: async () => {
        const jwt = jwtRef.current;
        const res = await fetch(`/api/lists/${listId}/items/unskip-all`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ itemIds }),
          keepalive: true,
        });
        if (!res.ok) throw new Error(`Restore all failed: ${res.status}`);
      },
    });
  }, [jwtRef, listId, items, addMutation, enqueueSkip, setItems]);

  const handleOrder = useCallback(
    (itemId: string, ordered: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");

      // Optimistic update — ordered and skipped are mutually exclusive
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, ordered_at: ordered ? new Date().toISOString() : null, skipped_at: ordered ? null : i.skipped_at }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "order",
        payload: { listId, itemId, ordered },
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, ordered }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Order failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );

  const handleSetRecurring = useCallback(
```

Replace with:

```ts
    // restore anything skipped after this tap. An item still waiting for its create has a
    // temp- id the server doesn't know; its own skip mutation waits behind the create in
    // the sync engine, which sends it with the real id.
    const at = new Date().toISOString();
    const itemIds: string[] = [];
    for (const id of affectedIds) {
      if (id.startsWith("temp-")) enqueueSkip(id, false, at);
      else itemIds.push(id);
    }
    if (itemIds.length === 0) return;

    addMutation({
      id: genMutId(),
      type: "unskip-all",
      payload: { listId, itemIds },
    });
  }, [listId, items, addMutation, enqueueSkip, setItems]);

  const handleOrder = useCallback(
    (itemId: string, ordered: boolean) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.impactOccurred("light");
      const at = new Date().toISOString();

      // Optimistic update — ordered and skipped are mutually exclusive
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? { ...i, ordered_at: ordered ? at : null, skipped_at: ordered ? null : i.skipped_at }
            : i
        )
      );

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "order",
        payload: { listId, itemId, ordered, at },
      });
    },
    [listId, addMutation, setItems]
  );

  const handleSetRecurring = useCallback(
```

Current (10):

```ts
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, recurring }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Set recurring failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );

  const handleRestoreRecurring = useCallback(
```

Replace with:

```ts
      });
    },
    [listId, addMutation, setItems]
  );

  const handleRestoreRecurring = useCallback(
```

Current (11):

```ts
        execute: async () => {
          const jwt = jwtRef.current;
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId, restoreRecurring: true }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Restore recurring failed: ${res.status}`);
        },
      });
    },
    [jwtRef, listId, addMutation, setItems]
  );

  const handleRemoveDuplicates = useCallback(
```

Replace with:

```ts
      });
    },
    [listId, addMutation, setItems]
  );

  const handleRemoveDuplicates = useCallback(
```

Current (12):

```ts
          execute: async () => {
            const jwt = jwtRef.current;
            const res = await fetch(
              `/api/lists/${listId}/items?itemId=${item.id}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${jwt}` },
                keepalive: true,
              }
            );
            if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
          },
        });
      }
    },
    [jwtRef, listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );
```

Replace with:

```ts
        });
      }
    },
    [listId, items, addMutation, t, setItems, setUndoAction, restoreOrRevert, removeAgain]
  );
```

- [ ] **Step 13: Drag and drop.** In `src/hooks/useListDragDrop.ts`. The lock now ends at the drop: until the queued reorder lands, the new positions are the engine's pending `position` fields, and T4's realtime UPDATE overlay keeps them.

Current (1):

```ts
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown>; execute: () => Promise<string | void> }) => void;
  listId: string;
  jwtRef: React.RefObject<string | null>;
  groups: CategoryGroup[] | null;
}

export function useListDragDrop({
  items,
  setItems,
  addMutation,
  listId,
  jwtRef,
```

Replace with:

```ts
  addMutation: (mutation: { id: string; type: string; payload: Record<string, unknown> }) => void;
  listId: string;
  groups: CategoryGroup[] | null;
}

export function useListDragDrop({
  items,
  setItems,
  addMutation,
  listId,
```

Current (2):

```ts
        const categoryId = moveTo;
        addMutation({
          id: genMutId(),
          type: "set-category",
          payload: { listId, itemId: sourceId, categoryId },
          execute: async () => {
            const jwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: sourceId, categoryId }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Set category failed: ${res.status}`);
          },
        });
      }

      const mutId = genMutId();
      addMutation({
        id: mutId,
        type: "reorder",
        payload: { listId, orderedIds: updatedIds },
        execute: async () => {
          try {
            const jwt = jwtRef.current;
            const res = await fetch(`/api/lists/${listId}/items/reorder`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ orderedIds: updatedIds }),
              keepalive: true,
            });
            if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
          } finally {
            isDraggingRef.current = false;
          }
        },
      });
    },
    [items, groups, jwtRef, listId, addMutation, setItems]
```

Replace with:

```ts
        addMutation({
          id: genMutId(),
          type: "set-category",
          payload: { listId, itemId: sourceId, categoryId: moveTo },
        });
      }

      addMutation({
        id: genMutId(),
        type: "reorder",
        payload: { listId, orderedIds: updatedIds },
      });
      // The drag is over. Until the queued reorder lands, the positions on screen are
      // pending fields of the sync engine, which refresh and realtime keep.
      isDraggingRef.current = false;
    },
    [items, groups, listId, addMutation, setItems]
```

- [ ] **Step 14: Create `src/sync/overlay.ts`:**

```ts
import type { ItemData } from "@/src/types";

/**
 * A server row with the local value of every field a change still in the sync engine
 * touches (`pendingFields`), so a confirmation or refresh never undoes a change that has
 * not landed yet. Presence markers ("created", "deleted") are not row fields and are ignored.
 */
export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData {
  const merged: Record<string, unknown> = { ...server };
  for (const field of pending) {
    if (field in local) merged[field] = local[field as keyof ItemData];
  }
  return merged as unknown as ItemData;
}
```

- [ ] **Step 15: List page.** In `app/(app)/list/[id]/page.tsx`. Pair meanings:
  1. Imports.
  2. The `ItemData` type import.
  3. Add `jwt` to the `useTelegram()` destructure (skip if T1 already added it).
  4. Add `onMutationSuccess` before the `useMutationQueue` call and pass it.
  5. Drop `jwtRef` from the `useListDragDrop({...})` call.
  6. Add the flush effect right after the first-load effect.

Current (1):

```tsx
import { useMutationQueue, type MutationErrorInfo } from "@/src/hooks/useMutationQueue";
```

Replace with:

```tsx
import { useMutationQueue, type MutationErrorInfo, type QueuedMutation } from "@/src/hooks/useMutationQueue";
import { getSyncEngine } from "@/src/sync/engine";
import { overlayPending } from "@/src/sync/overlay";
```

Current (2):

```tsx
import { throwIfNotOk } from "@/src/utils/http";
```

Replace with:

```tsx
import { throwIfNotOk } from "@/src/utils/http";
import type { ItemData } from "@/src/types";
```

Current (3):

```tsx
    userId,
    jwtRef,
```

Replace with:

```tsx
    userId,
    jwt,
    jwtRef,
```

Current (4):

```tsx
  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory, onMutationError);
```

Replace with:

```tsx
  // A landed create swaps its temp row for the server's row, keeping the local value of
  // every field a later change (a tick, an edit, a drag) has not landed yet.
  const onMutationSuccess = useCallback((m: QueuedMutation, result: unknown) => {
    if (m.type !== "create" || typeof m.payload.tempId !== "string") return;
    const tempId = m.payload.tempId;
    const row = result as ItemData;
    const pending = getSyncEngine(listId).pendingFields(row.id);
    setItems((prev) =>
      prev.map((i) =>
        i.id === tempId
          ? { ...overlayPending(row, i, pending), creator_name: null, editor_name: null, _pending: false }
          : i
      )
    );
  }, [listId, setItems]);

  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory, onMutationError, onMutationSuccess);
```

Current (5):

```tsx
    listId,
    jwtRef,
```

Replace with:

```tsx
    listId,
```

Current (6):

```tsx
  }, [isReady, fetchItems]);
```

Replace with:

```tsx
  }, [isReady, fetchItems]);

  // Replay this list's saved changes once there is a token. The provider also flushes every
  // list after auth; this covers opening the list later in the session.
  useEffect(() => {
    if (jwt) void flushQueue();
  }, [jwt, flushQueue]);
```

- [ ] **Step 16: Remove the queue's own in-flight tracking.** The engine tracks in-flight now. In `src/utils/mutation-queue.ts`:

Current (1), delete these lines (no replacement):

```ts
  // Ephemeral, per-session, never persisted: which queued mutations have a request
  // in flight right now. A queued mutation is only removed on success, so without
  // this a flush triggered mid-request (focus / visibilitychange / the 45-minute
  // timer) re-runs the same executor and the request lands twice.
  private inFlight = new Set<string>();
```

Current (2), delete these lines (no replacement):

```ts

  markInFlight(id: string) {
    this.inFlight.add(id);
  }

  clearInFlight(id: string) {
    this.inFlight.delete(id);
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }
```

  Then in `__tests__/unit/mutation-queue.test.ts`, delete the whole `describe("MutationQueue in-flight tracking", ...)` block. The methods no longer exist, and the behavior it pinned (no double send while in flight; in-flight never persisted, so a reload replays) is now covered by `sync-engine.test.ts`: "a flush while a change is in flight does not send it twice", "a failed change keeps its place after a reload" and "a reload before the create returns replays the create…".

Current (1), delete these lines (no replacement):

```ts

describe("MutationQueue in-flight tracking", () => {
  it("reports a mutation as not in flight by default", () => {
    const q = new MutationQueue("list-1");
    q.enqueue({ id: "m1", type: "toggle", payload: {} });
    expect(q.isInFlight("m1")).toBe(false);
  });

  it("reports a marked mutation as in flight", () => {
    const q = new MutationQueue("list-1");
    q.enqueue({ id: "m1", type: "toggle", payload: {} });
    q.markInFlight("m1");
    expect(q.isInFlight("m1")).toBe(true);
  });

  it("stops reporting in flight once cleared", () => {
    const q = new MutationQueue("list-1");
    q.markInFlight("m1");
    q.clearInFlight("m1");
    expect(q.isInFlight("m1")).toBe(false);
  });

  it("keeps in-flight state out of the persisted queue", () => {
    const q = new MutationQueue("list-1");
    q.enqueue({ id: "m1", type: "toggle", payload: {} });
    q.markInFlight("m1");
    // A different instance for the same list reads the same localStorage, but
    // in-flight is per-session: a reload must be free to replay the mutation.
    expect(new MutationQueue("list-1").isInFlight("m1")).toBe(false);
    expect(JSON.stringify(q.getQueue())).not.toContain("inFlight");
  });

  it("tracks in-flight state independently per mutation", () => {
    const q = new MutationQueue("list-1");
    q.markInFlight("m1");
    expect(q.isInFlight("m2")).toBe(false);
  });
});
```

- [ ] **Step 17: Run to green.**
  - The Step 9 command passes.
  - `npx vitest run` → all pass, including `no-silent-catches.test.ts`, `grouped-list-wiring.test.ts` (its `useListDragDrop({` slice still has `groups: categoryGroups`), `list-type-switch.test.ts` and `restore-skipped-wiring.test.ts`.
  - `npx tsc --noEmit` → clean.
  - `npx eslint src/utils/executor-factory.ts src/hooks/useMutationQueue.ts src/hooks/useItemHandlers.ts src/hooks/useListDragDrop.ts src/sync/overlay.ts src/utils/mutation-queue.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/single-executor.test.ts __tests__/unit/mutation-queue-hook.test.ts __tests__/unit/tap-time.test.ts __tests__/unit/list-sync-wiring.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/grouped-drag-hook.test.ts __tests__/unit/mutation-queue.test.ts` → clean.

- [ ] **Step 18: Make it bite.** Apply each edit, run the named file, see the test go red, restore.

| Edit | Run | Goes red |
|---|---|---|
| `src/hooks/useMutationQueue.ts`: insert `useEffect(() => { void getSyncEngine(listId).flush(); }, [listId]);` above `const addMutation` | `mutation-queue-hook.test.ts` | "does not flush on mount: replay waits for the page's flush" |
| `useItemHandlers.ts`: `payload: { listId, itemId, completed, at },` → `payload: { listId, itemId, completed },` | `tap-time.test.ts` | "a tick sends the tap time…" |
| `useItemHandlers.ts`: `completed_at: completed ? at : null,` → `completed_at: completed ? new Date().toISOString() : null,` | `tap-time.test.ts` | "a tick sends the tap time, and shows it…" |
| same for `skipped, at` → `skipped` and `ordered, at` → `ordered` | `tap-time.test.ts` | "a skip sends the tap time", "marking on the way sends the tap time" |
| `executor-factory.ts` skip body: drop `, at: tapTime(mutation)` | `executor-factory.test.ts` | "skip sends the payload's tap time", "falls back to the time it was queued…" |
| `executor-factory.ts`: `case "restore":` → `case "restore-x":` | `executor-factory.test.ts`, `mutation-request-parity.test.ts` | the restore tests, "has a sample for every executor-factory case" |
| `executor-factory.ts`: delete `return recycled?.[0] ?? null;` | `executor-factory.test.ts` | "recycle resolves with the server's row" |
| `useItemHandlers.ts`: add `execute: async () => { await fetch(\`/api/lists/${listId}/items\`, { method: "PATCH" }); },` after the edit payload | `single-executor.test.ts` | "src/hooks/useItemHandlers.ts: no addMutation call carries its own request" |
| `useItemHandlers.ts`: `type: "set-recurring",` → `type: "set-recurring-x",` | `single-executor.test.ts` | "…every queued type has an executor-factory case" |
| page: `{ ...overlayPending(row, i, pending), creator_name` → `{ ...row, creator_name` | `list-sync-wiring.test.ts` | "a landed create keeps the tick…" |
| page: `if (jwt) void flushQueue();` → `void flushQueue();` | `list-sync-wiring.test.ts` | "flushes the list's saved changes once a token exists, not before (H3)" |
| `useListDragDrop.ts`: delete the `isDraggingRef.current = false;` after the reorder `addMutation` | `grouped-drag-hook.test.ts` | "queues the changes for the sync engine to send, and ends the drag at the drop" |

- [ ] **Step 19: Commit.**
  ```bash
  git add src/utils/executor-factory.ts src/hooks/useMutationQueue.ts src/hooks/useItemHandlers.ts src/hooks/useListDragDrop.ts src/sync/overlay.ts src/utils/mutation-queue.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/single-executor.test.ts __tests__/unit/mutation-queue-hook.test.ts __tests__/unit/tap-time.test.ts __tests__/unit/list-sync-wiring.test.ts __tests__/unit/restore-skipped-flow.test.ts __tests__/unit/grouped-drag-hook.test.ts __tests__/unit/mutation-queue.test.ts
  git commit -m "$(cat <<'EOF'
  refactor(sync): send every change through the engine and the executor factory

  addMutation now takes only id, type and payload: the inline execute closures in
  useItemHandlers and useListDragDrop are gone and executor-factory is the one
  request builder, online and on replay. useMutationQueue is a thin adapter over
  the module-level engine with no mount flush; the list page flushes once a JWT
  exists and swaps a created item's row while keeping fields still pending.
  Toggle, skip and order send the tap time; a queued restore type is added.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  EOF
  )"
  ```

---

### Task 3c: Recovery: refresh after a drop, replay every list after auth, 401 asks for a fresh token

**Files:**
- Create: `src/utils/coalesce.ts`
- Modify: `app/(app)/list/[id]/page.tsx` (refresh after a dropped change; `requestTokenRefresh` as `onAuthNeeded`)
- Modify: `components/TelegramProvider.tsx` (flush every list once a JWT exists)
- Test (modify): `__tests__/unit/list-sync-wiring.test.ts`
- Test (create): `__tests__/unit/provider-flush-all.test.ts`

**Interfaces:**
- Consumes:
  - `flushAllQueues(getJwt, executorFactory, onAuthNeeded?)` and `useMutationQueue(..., onAuthNeeded?)` from 3a/3b.
  - `requestTokenRefresh: () => void` from T1's `useReconnectOrchestrator` return and `useTelegram()` context. See concerns: if T1's final context has no such function, use `reconnect` in the same places.
  - `refreshItems: () => Promise<void>` from `useListData`.
- Produces: `export function coalesce(task: () => Promise<void>, failureLog: string): () => void` in `src/utils/coalesce.ts`.

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H17 | `app/list/[id]/page.tsx:85-94` reverts only a dropped create; any other dropped change stays on screen | `onMutationError` on `dropped` also runs a coalesced `refreshItems()` (drops during a running refresh share one more refresh) | `list-sync-wiring.test.ts` › "re-reads the list after a dropped change, one refresh at a time (H17)", "does not refresh for a change kept for retry" |
| H15 (replay) | only the open list page flushes (`app/list/[id]/page.tsx:153-162` registers it), so a list not reopened never syncs | provider effect on `jwt`: `flushAllQueues(() => jwtRef.current, executorFactory, () => requestTokenRefresh())` | `provider-flush-all.test.ts` › "flushes every queue once a token exists, with a getter that reads the latest token" |
| H3 (401) | `useMutationQueue.ts:76-81` drops a 401 like any 4xx | engine keeps it (3a); the page and the provider pass a forced token refresh as `onAuthNeeded` | `list-sync-wiring.test.ts` › "asks for a fresh token when the engine reports a 401"; `provider-flush-all.test.ts` › "a 401 during that replay asks for a fresh token" |

- [ ] **Step 1: Extend `__tests__/unit/list-sync-wiring.test.ts`:**

Current (1):

```ts
};
const onSuccess = () => S.queueArgs[4] as (m: unknown, result: unknown) => void;
```

Replace with:

```ts
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
type OnError = (info: { mutationId: string; type: string; httpStatus: number | null; message: string; dropped: boolean; payload: Record<string, unknown> }) => void;
const onError = () => S.queueArgs[3] as OnError;
const onSuccess = () => S.queueArgs[4] as (m: unknown, result: unknown) => void;
```

Current (2):

```ts

  it("a landed create keeps the tick made on the item before its create answered (H5)", () => {
```

Replace with:

```ts

  it("re-reads the list after a dropped change, one refresh at a time (H17)", async () => {
    let finish: () => void = () => {};
    S.refreshItems = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render();
    const drop = { mutationId: "m1", type: "toggle", httpStatus: 400, message: "Toggle failed: 400", dropped: true, payload: { itemId: "i1" } };

    onError()(drop);
    onError()({ ...drop, mutationId: "m2" });
    onError()({ ...drop, mutationId: "m3" });
    expect(S.refreshItems).toHaveBeenCalledOnce();

    finish();
    await settle();
    expect(S.refreshItems).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a change kept for retry", () => {
    render();
    onError()({ mutationId: "m1", type: "toggle", httpStatus: 503, message: "Toggle failed: 503", dropped: false, payload: {} });
    expect(S.refreshItems).not.toHaveBeenCalled();
  });

  it("a landed create keeps the tick made on the item before its create answered (H5)", () => {
```

Current (3):

```ts
  });
});
```

Replace with:

```ts
  });

  it("asks for a fresh token when the engine reports a 401", () => {
    S.requestTokenRefresh = vi.fn();
    render();
    expect(S.queueArgs[5]).toBe(S.requestTokenRefresh);
  });
});
```

- [ ] **Step 2: Create `__tests__/unit/provider-flush-all.test.ts`.** The mocks spread the real hook modules, so T1's extra exports (`isInitDataFresh`, `readStoredToken`, `MAX_RETRIES`, …) stay available. Only effects whose deps include `jwtRef` are run, which is the new replay effect; T1's other provider effects depend on `[]` or `[isReady, jwt, loadUser]`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Calls the real TelegramProvider as a plain function with slot-based stand-ins for React's
// hooks (pattern: telegram-provider-bootstrap.test.ts). Effects are recorded; the test runs
// the ones that depend on the token. The extracted hooks are stubbed.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { value: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (v: unknown) => { slot.value = v; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const H = vi.hoisted(() => ({
  jwt: null as string | null,
  jwtRef: { current: null as string | null },
  requestTokenRefresh: () => {},
  flushAllQueues: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next-intl", () => ({ NextIntlClientProvider: () => null }));
vi.mock("@/src/lib/supabase", () => ({ createBrowserClient: () => ({}) }));
vi.mock("@/src/hooks/useJWTRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/hooks/useJWTRefresh")>()),
  useJWTRefresh: () => ({ jwt: H.jwt, jwtRef: H.jwtRef, fetchToken: async () => null, setToken: () => {}, clearJwt: () => {} }),
}));
vi.mock("@/src/hooks/useLocaleSync", () => ({
  useLocaleSync: () => ({ locale: "en", applyLocale: () => {}, setLanguage: async () => {} }),
}));
vi.mock("@/src/hooks/useHomeScreen", () => ({
  useHomeScreen: () => ({ homeScreenStatus: null, setHomeScreenStatus: () => {}, addToHomeScreen: () => {} }),
}));
vi.mock("@/src/hooks/useReconnectOrchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/hooks/useReconnectOrchestrator")>()),
  useReconnectOrchestrator: () => ({
    connectionStatus: "connecting", retryCount: 0, reconnect: () => {}, runReconnectRef: { current: () => {} }, setOrchestratorState: () => {}, startSession: () => {}, requestTokenRefresh: H.requestTokenRefresh,
  }),
}));
vi.mock("@/src/sync/engine", () => ({ flushAllQueues: (...args: unknown[]) => H.flushAllQueues(...args) }));

import TelegramProvider from "@/components/TelegramProvider";

// Renders once with this token and runs the effects that depend on the token's ref.
function renderWith(jwt: string | null) {
  H.jwt = jwt;
  H.jwtRef.current = jwt;
  R.i = 0;
  R.effects = [];
  TelegramProvider({ children: null });
  for (const e of R.effects) if (e.deps?.includes(H.jwtRef)) e.fn();
}

beforeEach(() => {
  R.slots = [];
  H.flushAllQueues = vi.fn(async () => {});
  H.requestTokenRefresh = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramProvider replays every list's saved changes after auth (H15)", () => {
  it("flushes every queue once a token exists, with a getter that reads the latest token", () => {
    renderWith(null);
    expect(H.flushAllQueues).not.toHaveBeenCalled();

    renderWith("tok-1");
    expect(H.flushAllQueues).toHaveBeenCalledOnce();
    const [getJwt, factory] = H.flushAllQueues.mock.calls[0] as [() => string | null, unknown];
    expect(typeof factory).toBe("function");
    H.jwtRef.current = "tok-2";
    expect(getJwt()).toBe("tok-2");
  });

  it("a 401 during that replay asks for a fresh token", () => {
    renderWith("tok-1");
    for (const e of R.effects) if (e.deps?.includes(H.requestTokenRefresh)) e.fn();
    const onAuthNeeded = H.flushAllQueues.mock.calls[0][2] as () => void;
    onAuthNeeded();
    expect(H.requestTokenRefresh).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run and watch them fail.**

  Run: `npx vitest run __tests__/unit/list-sync-wiring.test.ts __tests__/unit/provider-flush-all.test.ts`

  Expected:
  - "re-reads the list after a dropped change…" fails (`expected "spy" to be called once, but got 0 times`).
  - "asks for a fresh token…" fails (`S.queueArgs[5]` is undefined).
  - Both provider tests fail (`flushAllQueues` never called).
  - "does not refresh for a change kept for retry" already passes.

- [ ] **Step 4: Create `src/utils/coalesce.ts`:**

```ts
/**
 * Wraps an async task so calls made while it runs collapse into one more run after it
 * finishes. A failed run is logged with `failureLog` (e.g. "[List] Refresh failed") and
 * never rejects.
 */
export function coalesce(task: () => Promise<void>, failureLog: string): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    do {
      again = false;
      try {
        await task();
      } catch (err) {
        console.error(`${failureLog}:`, err);
      }
    } while (again);
    running = false;
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void run();
  };
}
```

- [ ] **Step 5: List page.** In `app/(app)/list/[id]/page.tsx`. Pair meanings:
  1. Import `coalesce`.
  2. Add `requestTokenRefresh` to the `useTelegram()` destructure.
  3. Add `refreshAfterDrop` above `onMutationError` and call it on a drop.
  4. Pass `requestTokenRefresh` as `useMutationQueue`'s 6th argument.

Current (1):

```tsx
import { overlayPending } from "@/src/sync/overlay";
```

Replace with:

```tsx
import { overlayPending } from "@/src/sync/overlay";
import { coalesce } from "@/src/utils/coalesce";
```

Current (2):

```tsx
    jwtRef,
    onFlushNeededRef,
```

Replace with:

```tsx
    jwtRef,
    requestTokenRefresh,
    onFlushNeededRef,
```

Current (3):

```tsx

  const onMutationError = useCallback((info: MutationErrorInfo) => {
    if (info.dropped) {
      setErrorToast(t('items.syncError'));
      setTimeout(() => setErrorToast(null), 3000);
      // Remove the optimistic pending item when a create mutation is permanently dropped
      if (info.type === "create" && typeof info.payload?.tempId === "string") {
        setItems((prev) => prev.filter((i) => i.id !== info.payload.tempId));
      }
    }
  }, [t, setItems]);
```

Replace with:

```tsx

  // A dropped change may still show on screen: re-read the list. Drops that come in while a
  // refresh runs share one more refresh after it.
  const refreshAfterDrop = useMemo(
    () => coalesce(refreshItems, "[List] Refresh after a dropped change failed"),
    [refreshItems]
  );

  const onMutationError = useCallback((info: MutationErrorInfo) => {
    if (info.dropped) {
      setErrorToast(t('items.syncError'));
      setTimeout(() => setErrorToast(null), 3000);
      // Remove the optimistic pending item when a create mutation is permanently dropped
      if (info.type === "create" && typeof info.payload?.tempId === "string") {
        setItems((prev) => prev.filter((i) => i.id !== info.payload.tempId));
      }
      refreshAfterDrop();
    }
  }, [t, setItems, refreshAfterDrop]);
```

Current (4):

```tsx
  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory, onMutationError, onMutationSuccess);
```

Replace with:

```tsx
  const { addMutation, flushQueue } = useMutationQueue(listId, getJwt, executorFactory, onMutationError, onMutationSuccess, requestTokenRefresh);
```

- [ ] **Step 6: Provider.** In `components/TelegramProvider.tsx`:
  1. Import the engine and executor factory, and create one module-level factory under the orchestrator import.
  2. Insert the replay effect directly above `// Keep heartbeat ref in sync with orchestrator's runReconnectRef`, where `jwt`, `jwtRef` and `requestTokenRefresh` are all in scope.

Current (1):

```tsx
import { useReconnectOrchestrator, MAX_RETRIES } from "@/src/hooks/useReconnectOrchestrator";
```

Replace with:

```tsx
import { useReconnectOrchestrator, MAX_RETRIES } from "@/src/hooks/useReconnectOrchestrator";
import { flushAllQueues } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

const executorFactory = createExecutorFactory();
```

Current (2):

```tsx
    router,
  });
```

Replace with:

```tsx
    router,
  });

  // Once there is a token, replay every list's saved changes, so a list the user does not
  // reopen still syncs. A 401 there asks for a fresh token.
  const tokenRefreshForSyncRef = useRef(requestTokenRefresh);
  useEffect(() => {
    tokenRefreshForSyncRef.current = requestTokenRefresh;
  }, [requestTokenRefresh]);
  useEffect(() => {
    if (!jwt) return;
    void flushAllQueues(() => jwtRef.current, executorFactory, () => tokenRefreshForSyncRef.current());
  }, [jwt, jwtRef]);
```

- [ ] **Step 7: Run to green.**
  - The Step 3 command passes (5 + 2 tests).
  - `npx vitest run` → all pass. `no-silent-catches.test.ts` stays green: `coalesce`'s catch logs `err`.
  - `npx tsc --noEmit` → clean.
  - `npx eslint src/utils/coalesce.ts "app/(app)/list/[id]/page.tsx" components/TelegramProvider.tsx __tests__/unit/list-sync-wiring.test.ts __tests__/unit/provider-flush-all.test.ts` → clean.

- [ ] **Step 8: Make it bite.**

| Edit | Run | Goes red |
|---|---|---|
| page: delete `refreshAfterDrop();` in `onMutationError` | `list-sync-wiring.test.ts` | "re-reads the list after a dropped change, one refresh at a time (H17)" |
| page: `() => coalesce(refreshItems, "[List] Refresh after a dropped change failed"),` → `() => () => void refreshItems(),` | `list-sync-wiring.test.ts` | same test (3 refreshes instead of 1, then 2) |
| page: `onMutationError, onMutationSuccess, requestTokenRefresh);` → `onMutationError, onMutationSuccess);` | `list-sync-wiring.test.ts` | "asks for a fresh token when the engine reports a 401" |
| provider: delete `if (!jwt) return;` in the replay effect | `provider-flush-all.test.ts` | "flushes every queue once a token exists…" |
| provider: delete the `void flushAllQueues(...)` line | `provider-flush-all.test.ts` | both tests |
| provider: `executorFactory, () => tokenRefreshForSyncRef.current());` → `executorFactory);` | `provider-flush-all.test.ts` | "a 401 during that replay asks for a fresh token" |

- [ ] **Step 9: Commit.**
  ```bash
  git add src/utils/coalesce.ts "app/(app)/list/[id]/page.tsx" components/TelegramProvider.tsx __tests__/unit/list-sync-wiring.test.ts __tests__/unit/provider-flush-all.test.ts
  git commit -m "$(cat <<'EOF'
  fix(sync): refresh after a dropped change and replay every list after auth

  A change the server refuses now re-reads the list, so the row shows the server's
  truth; drops during a refresh share one more refresh. Once a JWT exists the
  provider replays every saved list queue, so a list the user does not reopen still
  syncs, and a 401 from the queue asks for a fresh token.

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  EOF
  )"
  ```

### Task 4: Merge: the screen overlays unconfirmed changes instead of overwriting them

Two reviewable diffs, each ending green with its own commit: **4a** (H7, H9) makes the refresh and the realtime UPDATE merge over the user's unconfirmed changes and makes an added item show once; **4b** (H12, H18) catches up after supabase-js rejoins a channel by itself and makes a reconnect refresh even when the rejoin failed, with a failed refresh reported. Spec §4.

**Holes:**

| Hole | Root cause in code (today) | Change | Test that proves it |
|---|---|---|---|
| H7 refresh | `src/hooks/useListData.ts:188-212`: `refreshItems` returns `[...unresolvedPending, ...mapped]`; only `_pending` (create) rows survive, every other row is the GET snapshot; pending creates are "resolved" by a lowercase text count over all server rows, completed ones included | `mergeRefresh`: server row overlaid with the row's pending fields; rows changed on screen during the GET keep the newer local version; a pending delete or a row removed during the GET is not re-added; temp rows stay while `_pending`; no text matching | `list-merge-flows.test.ts` "a background refresh merges into the screen" (8 tests); `sync-merge.test.ts` "mergeRefresh" |
| H7 realtime | `src/hooks/useListRealtime.ts:60-80`: UPDATE does `{ ...i, ...newRec }` with no regard to unconfirmed local changes | the merged row goes through `overlayPending(merged, i, engine.pendingFields(i.id))` | `list-merge-flows.test.ts` "the echo of an older tick does not undo the untick still being saved, and a rename in it shows" |
| H9 | `src/hooks/useItemHandlers.ts:71-93`: the temp row and the POST keep the raw text, the server stores `normalizeForStorage(text)` (`app/api/lists/[id]/items/route.ts:116`), so `useListRealtime.ts:50-52` (`i.text === newRec.text`) misses and appends; the swap (`useItemHandlers.ts:117-124`, in the page after T3) maps temp→real without checking the real id is already on screen | `addSingleItem` normalizes the text it shows and sends; `applyCreateResult` drops the temp row when the saved id is already on screen | `list-merge-flows.test.ts` "an added item shows once" (3 tests); `sync-merge.test.ts` "applyCreateResult"; `list-merge-wiring.test.ts` "the list page's create answer" |
| H12 | `src/hooks/useRealtimeList.ts:128-145` (resubscribe callback returns early once `settled`) and `:169-175` (initial callback only logs `CHANNEL_ERROR`): supabase-js rejoins by itself and fires `SUBSCRIBED` again, the app never catches up | `watchRejoin`: `SUBSCRIBED` after `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` on the same channel calls `onRejoined`; the page passes a coalesced refresh | `realtime-rejoin.test.ts` (4 tests); `list-merge-wiring.test.ts` "the list page after a realtime rejoin" |
| H18 | `src/hooks/useReconnectOrchestrator.ts:148-156`: a rejected resubscribe jumps to `catch` and skips the refresh; `src/hooks/useListData.ts:172-175, 215-216`: `refreshItems` logs and resolves on a failed GET, so the orchestrator reports connected | `rejoinThenRefresh` always refreshes, then rethrows the rejoin error; `refreshItems` uses `throwIfNotOk` and rethrows from its catch | `reconnect-catch-up.test.ts`, `reconnect-steps.test.ts`, `list-data-categories.test.ts` "a failed background refresh … throws …" and "a background refresh that never reaches the server …" |

### Task 4a: Merge: refresh and realtime UPDATE overlay unconfirmed changes; an added item shows once (H7, H9)

**Before you start (what T1–T3 changed in the files this task touches):**
- T1 moved the list page to `app/(app)/list/[id]/page.tsx` (no `TelegramProvider` wrapper in it any more; it loads keyed on `jwt`). URLs are unchanged.
- T3 created `src/sync/engine.ts` (`getSyncEngine(listId).pendingFields(itemId)`; the temp→real map is recorded and the create dequeued before `onSuccess` runs), made `useMutationQueue` a thin adapter whose 5th argument is `onMutationSuccess`, made the `create` executor in `src/utils/executor-factory.ts` resolve with the server row, removed every inline `execute` closure from `src/hooks/useItemHandlers.ts` (callers pass only `{ id, type, payload }`), and moved the create's temp-row swap into the page's `onMutationSuccess`. T3's draft also adds `src/sync/overlay.ts` (`overlayPending(server, local, pending)`, which copies pending row fields and ignores the presence markers) used by that swap, and `src/utils/coalesce.ts` (`coalesce(task, failureLog)`), with which `onMutationError` refreshes the list after a dropped change (`refreshAfterDrop`).
- T1–T3 do not touch `src/hooks/useListData.ts` or `src/hooks/useListRealtime.ts`; their snippets below are today's code. Check with `git log --oneline -- src/hooks/useListData.ts src/hooks/useListRealtime.ts` (no commit after `2934605`). If one did change them, apply the same replacement to the code with the same meaning.

**Files:**
- Modify: `src/sync/overlay.ts` (T3's; replace the whole file, or create it if T3 did not: `overlayPending` also handles the presence markers)
- Create: `src/sync/merge.ts`
- Modify: `src/hooks/useListData.ts` (refreshItems merges; `itemsRef`)
- Modify: `src/hooks/useListRealtime.ts` (UPDATE overlays pending fields)
- Modify: `src/hooks/useItemHandlers.ts` (`addSingleItem` normalizes its text)
- Modify: `app/(app)/list/[id]/page.tsx` (the `create` success branch uses `applyCreateResult`)
- Test (create): `__tests__/unit/sync-merge.test.ts`, `__tests__/unit/list-merge-flows.test.ts`, `__tests__/unit/list-merge-wiring.test.ts`
- Test (modify): `__tests__/unit/list-data-categories.test.ts` (React stand-in gains `useRef`/`useEffect`; `localStorage` stub)

**Interfaces:**
- Consumes (T3): `getSyncEngine(listId: string): SyncEngine` with `pendingFields(itemId: string): Set<string>` (field names: `completed`, `completed_at`, `text`, `skipped_at`, `ordered_at`, `category_id`, `category_locked`, `recurring`, `position`, `deleted`, `created`); `useMutationQueue(listId, getJwt, executorFactory?, onMutationError?, onMutationSuccess?)`; `create` executor resolves with the server row; `EngineHandlers.onSuccess(m: QueuedMutation, result: unknown)`.
- Produces:
  ```ts
  // src/sync/overlay.ts (T3's signature; "deleted" now keeps the on-screen deleted_at, "created" keeps the whole on-screen row)
  export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData;
  // src/sync/merge.ts
  export type PendingFieldsOf = (itemId: string) => Set<string>;
  export function mergeRefresh(prev: ItemData[], base: ItemData[], server: ItemData[], pendingFields: PendingFieldsOf): ItemData[];
  export function applyCreateResult(prev: ItemData[], tempId: string, created: ItemData, pendingFields: PendingFieldsOf): ItemData[];
  ```
- Behavior change: `addSingleItem(text)` shows and sends `normalizeForStorage(text)`, and adds nothing when that is empty.

**Steps:**

- [ ] **Step 1: Write the failing pure merge test.** Create `__tests__/unit/sync-merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { overlayPending } from "@/src/sync/overlay";
import { mergeRefresh, applyCreateResult } from "@/src/sync/merge";
import type { ItemData } from "@/src/types";

const DONE = "2026-10-29T08:00:00.000Z";

function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// pendingFields as the engine reports it: item id -> fields of its unconfirmed changes.
const pending = (map: Record<string, string[]> = {}) => (id: string) => new Set(map[id] ?? []);
const ids = (rows: ItemData[]) => rows.map((i) => i.id).sort();
const byId = (rows: ItemData[], id: string) => rows.find((i) => i.id === id);

describe("overlayPending", () => {
  it("keeps the on-screen value of each pending field and takes every other field from the server", () => {
    const local = item({ id: "a", text: "milk", completed: true, completed_at: DONE });
    const server = item({ id: "a", text: "oat milk", completed: false, completed_at: null });
    expect(overlayPending(server, local, new Set(["completed", "completed_at"]))).toMatchObject({
      text: "oat milk", completed: true, completed_at: DONE,
    });
  });

  it("returns the server row untouched when nothing is pending", () => {
    const server = item({ id: "a", text: "oat milk" });
    expect(overlayPending(server, item({ id: "a" }), new Set())).toBe(server);
  });

  it("keeps the on-screen presence for a pending delete or restore", () => {
    const local = item({ id: "a", deleted_at: null });
    const server = item({ id: "a", deleted_at: DONE });
    expect(overlayPending(server, local, new Set(["deleted"])).deleted_at).toBeNull();
  });

  it("keeps the whole on-screen row while a recycle is on its way", () => {
    const local = item({ id: "a", completed: false, created_by: "u" });
    const server = item({ id: "a", completed: true, completed_at: DONE, created_by: "x" });
    expect(overlayPending(server, local, new Set(["created"]))).toBe(local);
  });
});

describe("mergeRefresh", () => {
  it("a tick still being saved stays ticked while a collaborator's rename shows", () => {
    const a = item({ id: "a", text: "milk", completed: true, completed_at: DONE });
    const out = mergeRefresh([a], [a], [item({ id: "a", text: "oat milk" })], pending({ a: ["completed", "completed_at"] }));
    expect(byId(out, "a")).toMatchObject({ text: "oat milk", completed: true, completed_at: DONE });
  });

  it("a confirmed row takes the server's values", () => {
    const a = item({ id: "a", completed: true, completed_at: DONE });
    const out = mergeRefresh([a], [a], [item({ id: "a", completed: false })], pending());
    expect(byId(out, "a")?.completed).toBe(false);
  });

  it("a row deleted on screen, with the delete still on its way, is not brought back", () => {
    const out = mergeRefresh([], [], [item({ id: "a" })], pending({ a: ["deleted"] }));
    expect(ids(out)).toEqual([]);
  });

  it("a restored row whose restore is on its way stays although the server still has it deleted", () => {
    const a = item({ id: "a" });
    const out = mergeRefresh([a], [a], [], pending({ a: ["deleted"] }));
    expect(ids(out)).toEqual(["a"]);
  });

  it("an unsaved new item stays next to a completed item with the same text", () => {
    const temp = item({ id: "temp-1", text: "milk", _pending: true });
    const old = item({ id: "old", text: "milk", completed: true, completed_at: DONE });
    const out = mergeRefresh([temp, old], [temp, old], [old], pending({ "temp-1": ["created"] }));
    expect(ids(out)).toEqual(["old", "temp-1"]);
    expect(byId(out, "temp-1")?._pending).toBe(true);
  });

  it("a row the server no longer has leaves the screen when nothing of the user's is pending", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    expect(ids(mergeRefresh([a, b], [a, b], [a], pending()))).toEqual(["a"]);
  });

  it("a row a collaborator added appears", () => {
    const a = item({ id: "a" });
    expect(ids(mergeRefresh([a], [a], [a, item({ id: "c" })], pending()))).toEqual(["a", "c"]);
  });

  it("a row that changed on screen while the GET was out keeps the newer on-screen version", () => {
    // The tick was confirmed and its echo applied before the older snapshot came back.
    const before = item({ id: "a" });
    const now = item({ id: "a", completed: true, completed_at: DONE });
    const out = mergeRefresh([now], [before], [item({ id: "a" })], pending());
    expect(byId(out, "a")).toBe(now);
  });

  it("a create that landed while the GET was out stays, although the snapshot predates it", () => {
    const temp = item({ id: "temp-1", text: "eggs", _pending: true });
    const saved = item({ id: "r1", text: "eggs" });
    expect(ids(mergeRefresh([saved], [temp], [], pending()))).toEqual(["r1"]);
  });

  it("a row removed from the screen while the GET was out is not brought back", () => {
    const a = item({ id: "a" });
    expect(ids(mergeRefresh([], [a], [a], pending()))).toEqual([]);
  });
});

describe("applyCreateResult", () => {
  const saved = item({ id: "r1", text: "Kid's cereal", creator_name: "Dana" });

  it("turns the temp row into the saved row", () => {
    const temp = item({ id: "temp-1", text: "Kid's cereal", _pending: true });
    const out = applyCreateResult([temp], "temp-1", saved, pending());
    expect(out).toEqual([{ ...saved, creator_name: null, editor_name: null, _pending: false }]);
  });

  it("drops the temp row when the realtime INSERT already put the saved row on screen", () => {
    const temp = item({ id: "temp-1", text: "Kid’s  cereal", _pending: true });
    const out = applyCreateResult([temp, saved], "temp-1", saved, pending());
    expect(out.map((i) => i.id)).toEqual(["r1"]);
  });

  it("keeps a tick made on the new item that is still on its way", () => {
    const temp = item({ id: "temp-1", text: "Kid's cereal", _pending: true, completed: true, completed_at: DONE });
    const out = applyCreateResult([temp], "temp-1", saved, pending({ r1: ["completed", "completed_at"] }));
    expect(out[0]).toMatchObject({ id: "r1", completed: true, completed_at: DONE, _pending: false });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  Run: `npx vitest run __tests__/unit/sync-merge.test.ts`
  Expected: FAIL, `Failed to resolve import "@/src/sync/merge"` (and `"@/src/sync/overlay"` if T3 did not create it).

- [ ] **Step 3: Give `overlayPending` the presence markers, and add the merge functions.** Replace the whole of `src/sync/overlay.ts` (create it if T3 did not) with:

```ts
import type { ItemData } from "@/src/types";

/**
 * A server row with the on-screen values of the fields the user changed and the server
 * hasn't confirmed yet (`pendingFields`), so a confirmation, a refresh or a realtime echo
 * never undoes a change that has not landed. Everything else, a collaborator's change
 * included, comes from the server. Of the presence markers, "deleted" keeps the on-screen
 * deleted_at, and "created" (a create or recycle still on its way) keeps the whole
 * on-screen row.
 */
export function overlayPending(server: ItemData, local: ItemData, pending: Set<string>): ItemData {
  if (pending.size === 0) return server;
  if (pending.has("created")) return local;
  const merged: Record<string, unknown> = { ...server };
  const mine = local as unknown as Record<string, unknown>;
  for (const field of pending) {
    if (field === "deleted") merged.deleted_at = local.deleted_at;
    else if (field in mine) merged[field] = mine[field];
  }
  return merged as unknown as ItemData;
}
```

  T3's only caller (the page's create swap) passes the pending fields of the saved id after the create left the queue, so it never sees "created"; Step 13 moves that swap into `applyCreateResult` anyway.

  Create `src/sync/merge.ts` (whole file):

```ts
import type { ItemData } from "@/src/types";
import { overlayPending } from "@/src/sync/overlay";

/** The item fields a queued or in-flight change touches (SyncEngine.pendingFields). */
export type PendingFieldsOf = (itemId: string) => Set<string>;

/**
 * A background refresh merged into the screen instead of replacing it.
 * - `prev`: the rows on screen now; `base`: the rows on screen when the GET went out;
 *   `server`: the GET's rows.
 * - A row that changed on screen while the GET was out (an optimistic change, a realtime
 *   event, a create that landed) is newer than the snapshot and stays as it is.
 * - Any other row is the server row overlaid with its pending fields.
 * - A row only on screen stays while it is unsaved (`_pending`), changed during the GET, or
 *   has a change on its way that decides its presence (a restore) or its whole state.
 * - A row only on the server is added, unless its delete is on its way or it left the
 *   screen while the GET was out.
 * Pending creates are never matched to server rows by text: a completed row with the same
 * text is not the new item. The create's answer resolves its temp row (applyCreateResult).
 */
export function mergeRefresh(
  prev: ItemData[],
  base: ItemData[],
  server: ItemData[],
  pendingFields: PendingFieldsOf
): ItemData[] {
  const atStart = new Map(base.map((i) => [i.id, i]));
  const onScreen = new Map(prev.map((i) => [i.id, i]));
  const serverIds = new Set(server.map((i) => i.id));
  const changedDuringGet = (row: ItemData) => atStart.get(row.id) !== row;

  const onlyOnScreen = prev.filter((row) => {
    if (serverIds.has(row.id)) return false;
    if (row._pending || changedDuringGet(row)) return true;
    const fields = pendingFields(row.id);
    return fields.has("deleted") || fields.has("created");
  });
  const fromServer = server.flatMap((row) => {
    const local = onScreen.get(row.id);
    if (!local) return pendingFields(row.id).has("deleted") || atStart.has(row.id) ? [] : [row];
    if (changedDuringGet(local)) return [local];
    return [overlayPending(row, local, pendingFields(row.id))];
  });
  return [...onlyOnScreen, ...fromServer];
}

/**
 * The create's answer turns its temp row into the saved row, keeping the on-screen values of
 * any change made to the new item that is still on its way (a tick right after adding). When
 * the realtime INSERT got there first, the saved row is already on screen, so the temp row
 * just goes: the same id never shows twice.
 */
export function applyCreateResult(
  prev: ItemData[],
  tempId: string,
  created: ItemData,
  pendingFields: PendingFieldsOf
): ItemData[] {
  if (prev.some((i) => i.id === created.id)) return prev.filter((i) => i.id !== tempId);
  // The engine maps the temp id to the saved one before it reports success, so the item's
  // pending fields are under the saved id. The create itself is no longer among them.
  const fields = new Set(pendingFields(created.id));
  fields.delete("created");
  return prev.map((i) =>
    i.id === tempId
      ? overlayPending({ ...created, creator_name: null, editor_name: null, _pending: false }, i, fields)
      : i
  );
}
```

- [ ] **Step 4: Run it and see it pass.**
  Run: `npx vitest run __tests__/unit/sync-merge.test.ts`
  Expected: PASS, 17 tests. If T3 has tests for `overlayPending`, run them too; one that asserts the markers are ignored encodes the old behavior: change it to the new contract ("deleted" keeps the on-screen `deleted_at`, "created" keeps the on-screen row).

- [ ] **Step 5: Write the failing flow tests** (real `useListData`, `useListRealtime`, `useItemHandlers`, T3's engine and executor factory, fake server). Create `__tests__/unit/list-merge-flows.test.ts`:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hooks run as plain functions */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListData, useListRealtime and useItemHandlers on the real sync engine and
// executor factory, against a fake server. A minimal slot-based stand-in for React runs the
// hooks in node: state persists across renders, callbacks and memos follow their deps, and
// effects run synchronously during render. Nothing renders to a DOM.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
      return [slot.value, set];
    },
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn(), deps };
      return R.slots[i].value;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      if (s && typeof s.cleanup === "function") s.cleanup();
      R.slots[i] = { deps, cleanup: fn() };
    },
  };
});
// useListRealtime hands its change handler to useRealtimeList; keep it so a test can deliver events.
const RT = vi.hoisted(() => ({ onChange: null as ((change: unknown) => void) | null }));
vi.mock("@/src/hooks/useRealtimeList", () => ({
  useRealtimeList: (_c: unknown, _r: unknown, _l: unknown, onChange: (change: unknown) => void) => {
    RT.onChange = onChange;
    return { resubscribe: async () => {} };
  },
}));

import { useListData } from "@/src/hooks/useListData";
import { useListRealtime } from "@/src/hooks/useListRealtime";
import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { getSyncEngine } from "@/src/sync/engine";
import { applyCreateResult } from "@/src/sync/merge";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { ItemData } from "@/src/types";

const DONE = "2026-10-22T09:00:00.000Z";

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// Each test gets its own list id: the engine registry is module-level.
let listSeq = 0;

// One open list page: the hooks the page runs, the engine it attaches to, and a fake server.
// A request is answered with a status or held until the test releases it. Keys:
// "GET items", "PATCH <itemId>", "DELETE <itemId>", "POST <n>" (the n-th create, from 1).
function page(serverItems: ItemData[]) {
  const listId = `L${++listSeq}`;
  const server = { items: serverItems };
  const holds = new Set<string>();
  const waiting = new Map<string, (reply: { status: number; body?: unknown }) => void>();
  const replies = new Map<string, number>();
  const sent: { key: string; body: Record<string, unknown> | undefined }[] = [];
  let posts = 0;

  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (method === "GET" && url === "/api/lists") return { ok: true, status: 200, json: async () => [{ id: listId, name: "Groceries", type: "regular" }] };
    const key =
      method === "GET" ? "GET items"
      : method === "POST" ? `POST ${++posts}`
      : method === "DELETE" ? `DELETE ${new URL(url, "https://app.test").searchParams.get("itemId")}`
      : `${method} ${body.itemId}`;
    sent.push({ key, body });
    const answer = (): { status: number; body?: unknown } =>
      method === "GET" ? { status: replies.get(key) ?? 200, body: { items: server.items } } : { status: replies.get(key) ?? 200, body: {} };
    const reply = holds.has(key)
      ? await new Promise<{ status: number; body?: unknown }>((resolve) => waiting.set(key, resolve))
      : answer();
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }));

  const jwtRef = { current: "jwt" as string | null };
  const engine = getSyncEngine(listId);
  let data!: ReturnType<typeof useListData>;
  const render = () => {
    R.i = 0;
    data = useListData(listId, jwtRef);
    useListRealtime({
      supabaseClient: null,
      supabaseClientRef: { current: null },
      listId,
      setItems: data.setItems,
      setListName: data.setListName,
      setCategories: data.setCategories,
      isDraggingRef: { current: false },
      onListDeleted: () => {},
    });
    return useItemHandlers({
      listId,
      jwtRef,
      userId: "u",
      items: data.items,
      setItems: data.setItems,
      addMutation: (m: { id: string; type: string; payload: Record<string, unknown> }) =>
        engine.add({ id: m.id, type: m.type, payload: m.payload }),
      setUndoAction: () => {},
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: () => {},
      t: (key: string) => key,
    });
  };
  // The page's create success handler: the saved row replaces the temp row.
  const detach = engine.attach({
    getJwt: () => jwtRef.current,
    executorFactory: createExecutorFactory(),
    onSuccess: (m, result) => {
      if (m.type === "create" && typeof m.payload.tempId === "string") {
        const tempId = m.payload.tempId;
        data.setItems((prev) => applyCreateResult(prev, tempId, result as ItemData, (id) => engine.pendingFields(id)));
      }
    },
  });

  return {
    listId,
    server,
    render,
    detach,
    hold: (key: string) => holds.add(key),
    reply: (key: string, status: number) => replies.set(key, status),
    release: (key: string, status: number, body: unknown = {}) => {
      holds.delete(key);
      waiting.get(key)!({ status, body });
    },
    realtime: (change: { eventType: string; new?: object; old?: object }) => {
      render();
      RT.onChange!({ table: "items", new: {}, old: {}, ...change });
    },
    load: async () => {
      render();
      await data.fetchItems();
    },
    refresh: async () => {
      render();
      await data.refreshItems();
    },
    items: () => { render(); return data.items; },
    item: (id: string) => { render(); return data.items.find((i) => i.id === id); },
    sent,
  };
}

let current: ReturnType<typeof page> | null = null;
// Opens the list page on a server holding these items.
const open = async (serverItems: ItemData[]) => {
  current = page(serverItems);
  await current.load();
  return current;
};

beforeEach(() => {
  R.slots = [];
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  current?.detach();
  current = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a background refresh merges into the screen", () => {
  it("a tick still being saved stays ticked, and a collaborator's rename of the item still shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;

    p.server.items = [row({ id: "a", text: "oat milk" })];
    await p.refresh();

    expect(p.item("a")).toMatchObject({ text: "oat milk", completed: true });
  });

  it("once the tick is saved, the server's values show again", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    p.release("PATCH a", 200);
    await settle();

    // A collaborator unticked it after the tick was saved.
    p.server.items = [row({ id: "a", text: "milk", completed: false })];
    await p.refresh();

    expect(p.item("a")?.completed).toBe(false);
  });

  it("a tick kept for retry after a server error stays ticked through a refresh", async () => {
    const p = await open([row({ id: "a" })]);
    p.reply("PATCH a", 500);
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await settle();

    await p.refresh();

    expect(p.item("a")?.completed).toBe(true);
  });

  it("a new item still being saved stays on screen next to a saved item with the same text", async () => {
    const p = await open([row({ id: "old", text: "milk" })]);
    p.hold("POST 1");
    await p.render().handleAddItem("milk");

    await p.refresh();

    const milks = p.items().filter((i) => i.text === "milk").map((i) => i.id);
    expect(milks).toHaveLength(2);
    expect(milks).toEqual(expect.arrayContaining(["old", expect.stringMatching(/^temp-/)]));
  });

  it("an item deleted on screen with its delete still on its way is not brought back", async () => {
    const p = await open([row({ id: "a" }), row({ id: "b" })]);
    p.hold("DELETE a");
    await p.render().handleDelete("a");
    await vi.advanceTimersByTimeAsync(200);

    await p.refresh();

    expect(p.items().map((i) => i.id)).toEqual(["b"]);
  });

  it("an item whose create finished while the GET was out stays, although the snapshot predates it", async () => {
    const p = await open([]);
    p.hold("POST 1");
    await p.render().handleAddItem("eggs");
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    // The create is answered and its echo arrives, then the older snapshot comes back.
    p.release("POST 1", 201, { items: [row({ id: "r1", text: "eggs" })] });
    await settle();
    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "eggs" }) });
    p.release("GET items", 200, { items: [] });
    await refreshing;

    expect(p.items().map((i) => i.id)).toEqual(["r1"]);
  });
  it("a tick saved while the GET was out, with its echo already in, survives the older snapshot", async () => {
    const p = await open([row({ id: "a" })]);
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await settle();
    p.realtime({ eventType: "UPDATE", new: row({ id: "a", completed: true, completed_at: DONE }) });
    p.release("GET items", 200, { items: [row({ id: "a" })] });
    await refreshing;

    expect(p.item("a")?.completed).toBe(true);
  });

  it("an item a collaborator deleted while the GET was out is not brought back by the older snapshot", async () => {
    const p = await open([row({ id: "a" }), row({ id: "b" })]);
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    p.realtime({ eventType: "DELETE", old: { id: "b" } });
    p.release("GET items", 200, { items: [row({ id: "a" }), row({ id: "b" })] });
    await refreshing;

    expect(p.items().map((i) => i.id)).toEqual(["a"]);
  });
});

describe("a realtime UPDATE merges into the screen", () => {
  it("the echo of an older tick does not undo the untick still being saved, and a rename in it shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await p.render().handleToggle("a", false);
    await settle();

    p.realtime({ eventType: "UPDATE", new: row({ id: "a", text: "oat milk", completed: true, completed_at: DONE }) });

    expect(p.item("a")).toMatchObject({ text: "oat milk", completed: false, completed_at: null });
  });

  it("with nothing of the user's pending, the server's row shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);

    p.realtime({ eventType: "UPDATE", new: row({ id: "a", text: "milk", completed: true, completed_at: DONE }) });

    expect(p.item("a")).toMatchObject({ completed: true, completed_at: DONE });
  });
});

describe("an added item shows once", () => {
  it("text the server normalizes is shown and sent normalized, so an INSERT that beats the answer replaces the temp row", async () => {
    const p = await open([]);
    p.hold("POST 1");
    await p.render().handleAddItem("Kid’s  cereal");

    expect(p.items().map((i) => i.text)).toEqual(["Kid's cereal"]);
    expect(p.sent.find((s) => s.key === "POST 1")?.body).toMatchObject({ text: "Kid's cereal" });

    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "Kid's cereal" }) });
    expect(p.items().map((i) => i.id)).toEqual(["r1"]);

    p.release("POST 1", 201, { items: [row({ id: "r1", text: "Kid's cereal" })] });
    await settle();
    expect(p.items().map((i) => i.id)).toEqual(["r1"]);
  });

  it("two same-text adds whose echoes and answers interleave leave each saved id once", async () => {
    const p = await open([]);
    p.hold("POST 1");
    p.hold("POST 2");
    await p.render().handleAddItem("milk, milk");
    await settle();

    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "milk" }) });
    p.release("POST 1", 201, { items: [row({ id: "r1", text: "milk" })] });
    await settle();
    p.realtime({ eventType: "INSERT", new: row({ id: "r2", text: "milk" }) });
    p.release("POST 2", 201, { items: [row({ id: "r2", text: "milk" })] });
    await settle();

    expect(p.items().map((i) => i.id).sort()).toEqual(["r1", "r2"]);
  });

  it("an item that is only invisible characters is not added", async () => {
    const p = await open([]);
    await p.render().handleAddItem("‎‏");
    await settle();
    expect(p.items()).toEqual([]);
    expect(p.sent.filter((s) => s.key.startsWith("POST"))).toEqual([]);
  });
});
```

  If T3 added params to `useItemHandlers`, pass the values T3's own `__tests__/unit/list-background-saves.test.ts` passes for them (it drives the same hook). `engine.attach`'s `onSuccess` here does what the page's `create` branch does after Step 13; the page itself is covered by `list-merge-wiring.test.ts`.

- [ ] **Step 6: Run it and see it fail.**
  Run: `npx vitest run __tests__/unit/list-merge-flows.test.ts`
  Expected: FAIL, 10 of 13: every test in "a background refresh merges into the screen" except "once the tick is saved, the server's values show again" (e.g. `expected { …, completed: false } to match object { text: 'oat milk', completed: true }`), "the echo of an older tick does not undo the untick still being saved, and a rename in it shows" (`completed: true`), "text the server normalizes is shown and sent normalized, …" (`expected [ 'Kid’s  cereal' ] to deeply equal [ 'Kid\'s cereal' ]`) and "an item that is only invisible characters is not added". The 3 that pass already ("once the tick is saved …", "with nothing of the user's pending …", "two same-text adds …", whose `onSuccess` already uses `applyCreateResult`) are the controls.

- [ ] **Step 7: Update the `useListData` harness for the new hooks.** `useListData` will call `useRef`/`useEffect` and ask the engine (which reads `localStorage`) for pending fields. In `__tests__/unit/list-data-categories.test.ts`:

  Replace
```ts
// Runs the real useListData against a faked network with a minimal slot-based React
// stand-in (state persists across calls, callbacks follow their deps). Nothing renders.
type Slot = { value?: unknown; deps?: unknown[] };
```
  with
```ts
// Runs the real useListData against a faked network with a minimal slot-based React
// stand-in (state and refs persist across calls, callbacks follow their deps, effects run
// during render when their deps change). Nothing renders.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[] };
```
  Replace
```ts
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
  };
});
```
  with
```ts
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useRef: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: init };
      return R.slots[i];
    },
    useEffect: (fn: () => void, deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      R.slots[i] = { deps };
      fn();
    },
  };
});
```
  Replace
```ts
beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
```
  with
```ts
beforeEach(() => {
  R.slots = [];
  // A refresh asks the sync engine which changes are still on their way; it reads the queue.
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
```
  (The file's `afterEach` already calls `vi.unstubAllGlobals()`.)

- [ ] **Step 8: Make `refreshItems` merge.** In `src/hooks/useListData.ts`:

  Replace
```ts
import { useState, useCallback } from "react";
```
  with
```ts
import { useState, useCallback, useEffect, useRef } from "react";
```
  Replace
```ts
import { throwIfNotOk } from "@/src/utils/http";
```
  with
```ts
import { throwIfNotOk } from "@/src/utils/http";
import { getSyncEngine } from "@/src/sync/engine";
import { mergeRefresh } from "@/src/sync/merge";
```
  Replace
```ts
  const [categories, setCategories] = useState<ListCategory[]>([]);
```
  (the first occurrence, inside `useListData`) with
```ts
  const [categories, setCategories] = useState<ListCategory[]>([]);
  // The rows on screen as of the last render: a refresh compares them with the rows on screen
  // when its answer comes back, to tell what changed while the GET was out.
  const itemsRef = useRef<ItemData[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
```
  Replace the whole `refreshItems` callback
```ts
  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        console.warn("[List] Background refresh failed:", { listId, status: res.status });
        return;
      }
      const { items: fetchedItems } = await res.json();

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
      setItems((prev) => {
        const pendingItems = prev.filter((i) => i._pending);
        const serverIds = new Set(mapped.map((i: ItemData) => i.id));

        // Count server items by text for count-aware dedup
        // (handles duplicate-text items correctly — only consume one match per server item)
        const serverTextCounts = new Map<string, number>();
        for (const item of mapped) {
          const key = item.text.toLowerCase();
          serverTextCounts.set(key, (serverTextCounts.get(key) || 0) + 1);
        }

        const unresolvedPending: ItemData[] = [];
        for (const pending of pendingItems) {
          if (serverIds.has(pending.id)) continue;
          const key = pending.text.toLowerCase();
          const serverCount = serverTextCounts.get(key) || 0;
          if (serverCount > 0) {
            serverTextCounts.set(key, serverCount - 1);
          } else {
            unresolvedPending.push(pending);
          }
        }

        return [...unresolvedPending, ...mapped];
      });
      if (listType === "grocery") await loadCategories();
    } catch (e) {
      console.error("[List] Background refresh error:", e);
    }
  }, [jwtRef, listId, listType, loadCategories]);
```
  with
```ts
  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const base = itemsRef.current;
    try {
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) {
        console.warn("[List] Background refresh failed:", { listId, status: res.status });
        return;
      }
      const { items: fetchedItems } = await res.json();

      const mapped: ItemData[] = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
        };
      });
      // Merge, never replace: a change the server hasn't confirmed keeps its fields on screen.
      const engine = getSyncEngine(listId);
      setItems((prev) => mergeRefresh(prev, base, mapped, (id) => engine.pendingFields(id)));
      if (listType === "grocery") await loadCategories();
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
    }
  }, [jwtRef, listId, listType, loadCategories]);
```

- [ ] **Step 9: Overlay pending fields on a realtime UPDATE.** In `src/hooks/useListRealtime.ts`:

  Replace
```ts
import { applyCategoryChange } from "@/src/utils/category-state";
```
  with
```ts
import { applyCategoryChange } from "@/src/utils/category-state";
import { getSyncEngine } from "@/src/sync/engine";
import { overlayPending } from "@/src/sync/overlay";
```
  Replace
```ts
        } else if (change.eventType === "UPDATE") {
          setItems((prev) =>
```
  with
```ts
        } else if (change.eventType === "UPDATE") {
          const engine = getSyncEngine(listId);
          setItems((prev) =>
```
  Replace
```ts
              if (updates.edited_by && updates.edited_by !== i.edited_by) {
                merged.editor_name = lookupUserName(prev, updates.edited_by as string);
              }
              return merged;
```
  with
```ts
              if (updates.edited_by && updates.edited_by !== i.edited_by) {
                merged.editor_name = lookupUserName(prev, updates.edited_by as string);
              }
              // A change of the user's the server hasn't confirmed keeps its fields: the echo of
              // an older change, or a collaborator's write to the same field, must not undo it.
              return overlayPending(merged, i, engine.pendingFields(i.id));
```
  Replace
```ts
    [setItems, setListName, setCategories, isDraggingRef, onListDeleted]
```
  with
```ts
    [setItems, setListName, setCategories, isDraggingRef, onListDeleted, listId]
```

- [ ] **Step 10: Normalize the optimistic text.** In `src/hooks/useItemHandlers.ts`:

  Replace
```ts
import { normalizeForCompare } from "@/src/utils/text-normalize";
```
  with
```ts
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";
```
  Replace the head of `addSingleItem` (T3 keeps it; only the `addMutation` call below it lost its `execute`)
```ts
  const addSingleItem = useCallback(
    (text: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
```
  with
```ts
  const addSingleItem = useCallback(
    (typed: string) => {
      // The server stores normalizeForStorage(text). Showing and sending that same text lets
      // the realtime INSERT find this row, so the item never shows twice.
      const text = normalizeForStorage(typed);
      if (!text) return;
      const tempId = `temp-${Date.now()}-${Math.random()}`;
```
  Everything below keeps using `text` (the temp row and the `create` payload), so both carry the normalized value. The `useCallback` deps do not change.

- [ ] **Step 11: Run the hook tests and see them pass.**
  Run: `npx vitest run __tests__/unit/list-merge-flows.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/sync-merge.test.ts`
  Expected: PASS (13 + 24 + 17).

- [ ] **Step 12: Write the failing page wiring test.** Create `__tests__/unit/list-merge-wiring.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemData } from "@/src/types";

// Renders the real list page with react-dom/server (node, no DOM). Its data hooks are stubbed:
// useListData hands it items and a refresh, and the stubs of useMutationQueue and
// useListRealtime keep what the page passes them, so a test can call the page's own handlers.
const S = vi.hoisted(() => ({
  items: [] as ItemData[],
  refreshCalls: 0,
  refreshFails: null as Error | null,
  onMutationSuccess: null as null | ((m: { id: string; type: string; payload: Record<string, unknown>; timestamp: number }, result: unknown) => void),
  realtimeArgs: null as null | { onRejoined?: () => void },
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    jwt: "jwt",
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwtRef: { current: "jwt" },
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: S.items,
    setItems: (u: ItemData[] | ((prev: ItemData[]) => ItemData[])) => { S.items = typeof u === "function" ? u(S.items) : u; },
    loading: false, error: null, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: async () => {}, fetchItems: async () => {},
    refreshItems: async () => {
      S.refreshCalls++;
      if (S.refreshFails) throw S.refreshFails;
    },
    retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: (...args: unknown[]) => {
    S.onMutationSuccess = args[4] as typeof S.onMutationSuccess;
    return { addMutation: () => {}, flushQueue: async () => {}, pendingFields: () => new Set<string>() };
  },
}));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({
  useListRealtime: (args: { onRejoined?: () => void }) => {
    S.realtimeArgs = args;
    return { resubscribe: async () => {} };
  },
}));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  Object.assign(S, { items: [], refreshCalls: 0, refreshFails: null, onMutationSuccess: null, realtimeArgs: null });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  renderToStaticMarkup(createElement(ListPage));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list page's create answer", () => {
  it("drops the temp row when the realtime INSERT already put the saved row on screen", () => {
    S.items = [row({ id: "temp-1", text: "milk", _pending: true }), row({ id: "r1", text: "milk" })];
    S.onMutationSuccess!(
      { id: "m1", type: "create", payload: { listId: "L", text: "milk", tempId: "temp-1" }, timestamp: 0 },
      row({ id: "r1", text: "milk" })
    );
    expect(S.items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("turns the temp row into the saved row otherwise", () => {
    S.items = [row({ id: "temp-1", text: "milk", _pending: true })];
    S.onMutationSuccess!(
      { id: "m1", type: "create", payload: { listId: "L", text: "milk", tempId: "temp-1" }, timestamp: 0 },
      row({ id: "r1", text: "milk" })
    );
    expect(S.items.map((i) => [i.id, i._pending])).toEqual([["r1", false]]);
  });
});
```

  If T1 or T3 made the page read more fields from `useTelegram`, `useListData` or `useMutationQueue` than these mocks return, `__tests__/unit/grouped-list-wiring.test.ts` (which T1/T3 kept green) mocks them: add the same fields with the same values here.

  Run: `npx vitest run __tests__/unit/list-merge-wiring.test.ts`
  Expected: FAIL, "drops the temp row when the realtime INSERT already put the saved row on screen" (`expected [ 'r1', 'r1' ] to deeply equal [ 'r1' ]`); "turns the temp row into the saved row otherwise" passes (control).

- [ ] **Step 13: The page's create answer uses `applyCreateResult`.** In `app/(app)/list/[id]/page.tsx`, the `onMutationSuccess` callback T3 added (5th argument of `useMutationQueue`) swaps the temp row. In T3's draft it reads:
```ts
    const row = result as ItemData;
    const pending = getSyncEngine(listId).pendingFields(row.id);
    setItems((prev) =>
      prev.map((i) =>
        i.id === tempId
          ? { ...overlayPending(row, i, pending), creator_name: null, editor_name: null, _pending: false }
          : i
      )
    );
```
  Replace it with
```ts
    const row = result as ItemData;
    const engine = getSyncEngine(listId);
    // The realtime INSERT may have put the saved row on screen first: then the temp row just goes.
    setItems((prev) => applyCreateResult(prev, tempId, row, (id) => engine.pendingFields(id)));
```
  If T3's final swap is written differently, replace whatever `setItems` call maps the temp row to the server row the same way, keeping T3's names for `tempId` and `row`, and keep `listId` in the callback's deps. Then replace the import `import { overlayPending } from "@/src/sync/overlay";` with `import { applyCreateResult } from "@/src/sync/merge";` (keep `overlayPending`'s import only if something else in the page still uses it), and make sure `getSyncEngine` is imported from `"@/src/sync/engine"`.

- [ ] **Step 14: Run everything.**
  - `npx vitest run __tests__/unit/list-merge-wiring.test.ts` → PASS (2).
  - `npx vitest run` → all green. If `__tests__/unit/list-background-saves.test.ts` now fails because the realtime UPDATE asks the engine (which reads `localStorage`) and its `world()` stubs no `localStorage`, add to the top of `world()` the same `localStorage` stub as in Step 7 (Map-backed `getItem`/`setItem`/`removeItem`/`key`/`length`); its assertions do not change.
  - `npx tsc --noEmit` → no errors.
  - `npx eslint src/sync/overlay.ts src/sync/merge.ts src/hooks/useListData.ts src/hooks/useListRealtime.ts src/hooks/useItemHandlers.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/sync-merge.test.ts __tests__/unit/list-merge-flows.test.ts __tests__/unit/list-merge-wiring.test.ts __tests__/unit/list-data-categories.test.ts` → clean.

- [ ] **Step 15: Make each check bite** (remove it, run the named test, see it red, restore it, see it green):
  1. `src/sync/merge.ts` `mergeRefresh`: replace `return [overlayPending(row, local, pendingFields(row.id))];` with `return [row];` → `list-merge-flows` "a tick still being saved stays ticked, …" and "a tick kept for retry after a server error …" go red.
  2. `mergeRefresh`: replace `pendingFields(row.id).has("deleted") || atStart.has(row.id)` with `atStart.has(row.id)` → "an item deleted on screen with its delete still on its way is not brought back" red.
  3. `mergeRefresh`: delete the line `if (changedDuringGet(local)) return [local];` → "a tick saved while the GET was out, with its echo already in, survives the older snapshot" red.
  4. `mergeRefresh`: replace `if (row._pending || changedDuringGet(row)) return true;` with `if (row._pending) return true;` → "an item whose create finished while the GET was out stays, …" red.
  5. `mergeRefresh`: replace `.has("deleted") || atStart.has(row.id) ? [] : [row]` with `.has("deleted") ? [] : [row]` → "an item a collaborator deleted while the GET was out is not brought back by the older snapshot" red.
  6. `useListData`: delete the `useEffect` that sets `itemsRef.current = items` → "once the tick is saved, the server's values show again" (and two more refresh tests) red.
  7. `useListRealtime`: replace `return overlayPending(merged, i, engine.pendingFields(i.id));` with `return merged;` → "the echo of an older tick does not undo the untick still being saved, …" red.
  8. `useItemHandlers`: replace `const text = normalizeForStorage(typed);` with `const text = typed.trim();` → "text the server normalizes is shown and sent normalized, …" and "an item that is only invisible characters is not added" red.
  9. `useItemHandlers`: delete `if (!text) return;` → "an item that is only invisible characters is not added" red.
  10. `applyCreateResult`: delete its first line (`if (prev.some(...)) return prev.filter(...)`) → `list-merge-flows` "two same-text adds whose echoes and answers interleave …", `sync-merge` "drops the temp row when …" and `list-merge-wiring` "drops the temp row when …" red.
  11. `applyCreateResult`: replace `overlayPending({ ...created, creator_name: null, editor_name: null, _pending: false }, i, fields)` with `({ ...created, creator_name: null, editor_name: null, _pending: false })` → `sync-merge` "keeps a tick made on the new item that is still on its way" red.
  12. Page: put T3's `prev.map(...)` swap back → `list-merge-wiring` "drops the temp row when …" red.
  13. `overlayPending`: delete `if (pending.has("created")) return local;` → `sync-merge` "keeps the whole on-screen row while a recycle is on its way" red.
  14. `overlayPending`: delete the `if (field === "deleted") merged.deleted_at = local.deleted_at; else` branch (keep the `if (field in mine)` line) → `sync-merge` "keeps the on-screen presence for a pending delete or restore" red.

- [ ] **Step 16: Commit.**
```bash
git add src/sync/overlay.ts src/sync/merge.ts src/hooks/useListData.ts src/hooks/useListRealtime.ts src/hooks/useItemHandlers.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/sync-merge.test.ts __tests__/unit/list-merge-flows.test.ts __tests__/unit/list-merge-wiring.test.ts __tests__/unit/list-data-categories.test.ts
# only if Step 14 needed it:
git add __tests__/unit/list-background-saves.test.ts
git commit -m "$(cat <<'MSG'
fix(sync): refresh and realtime overlay unconfirmed changes; an added item shows once

A background refresh merged over the screen instead of replacing it: each row is the
server row with the user's still-unconfirmed fields kept, rows that changed while the GET
was out keep the newer version, a pending delete is not brought back, and a new item is
never matched by text against a completed one. A realtime UPDATE keeps pending fields
the same way. A typed item is shown and sent in the server's normalized form, and a
create answer whose row the realtime INSERT already added drops the temp row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
MSG
)"
```

### Task 4b: Catch-up: refresh after a realtime rejoin; a reconnect refreshes even when the rejoin failed, and a failed refresh throws (H12, H18)

**Before you start:** 4a is committed. T1 rewrote `src/hooks/useReconnectOrchestrator.ts` (in its draft: `ensureToken` asks the server only for a token older than a day, `syncRealtime(token)` replaces `recreateSupabaseClient`, `startSession()` is the launch sign-in, `reconnect()` waits while "initializing", steps 3 "rejoin if not joined" and 4 "refresh" keep today's shape) and `src/hooks/useRealtimeList.ts` (in its draft: one `subscribe(client)` helper owns the list's only channel and its single status callback; `resubscribe()` resolves at once when that channel is joined). The snippets below quote T1's draft where it differs from today, and today's code otherwise; if T1's final code differs, apply each change to the code with the same meaning.

**Files:**
- Modify: `src/hooks/useRealtimeList.ts` (`watchRejoin`, 5th param `onRejoined`)
- Modify: `src/hooks/useListRealtime.ts` (`onRejoined` param passed through)
- Modify: `src/hooks/useListData.ts` (refreshItems throws on failure)
- Modify: `src/hooks/useReconnectOrchestrator.ts` (exported `rejoinThenRefresh`, used for the rejoin + refresh steps)
- Modify: `app/(app)/list/[id]/page.tsx` (`refreshAfterRejoin` through T3's `coalesce`, passed as `onRejoined`)
- Create only if T3 did not: `src/utils/coalesce.ts`
- Test (create): `__tests__/unit/realtime-rejoin.test.ts`, `__tests__/unit/reconnect-catch-up.test.ts`, `__tests__/unit/reconnect-steps.test.ts`
- Test (modify): `__tests__/unit/list-merge-wiring.test.ts` (rejoin describe), `__tests__/unit/list-data-categories.test.ts` (failed refresh now throws)

**Interfaces (produced):**
```ts
// src/hooks/useRealtimeList.ts
export function useRealtimeList(supabaseClient: SupabaseClient | null, supabaseClientRef: React.RefObject<SupabaseClient | null>, listId: string, onChange: (change: RealtimeChange) => void, onRejoined?: () => void): { resubscribe: () => Promise<void> /* plus whatever T1 returns */ };
// src/hooks/useListRealtime.ts: UseListRealtimeParams gains
onRejoined?: () => void;
// src/hooks/useReconnectOrchestrator.ts
export async function rejoinThenRefresh(rejoin: (() => Promise<void>) | null, refresh: (() => Promise<void>) | null): Promise<void>;
// src/hooks/useListData.ts: refreshItems(): Promise<void> now REJECTS on a non-2xx answer (Error "Background refresh failed: <status>") or a network failure.
```
Every caller of `refreshItems` other than the orchestrator registration (`onRefreshNeededRef.current = refreshItems`) must go through `coalesce(refreshItems, "<failure log>")` (T3's helper, which logs a failed run and never rejects).

**Steps:**

- [ ] **Step 1: Write the failing rejoin test.** Create `__tests__/unit/realtime-rejoin.test.ts`:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Runs the real useRealtimeList with slot-based stand-ins for React's hooks: refs persist
// across calls, effects are recorded and run by the test. The fake client hands the test
// each channel's status callback, so it can play what supabase-js reports.
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as { current: unknown }[], effects: [] as Effect[], i: 0 }));
vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.effects.push({ fn, deps });
    R.i++;
  },
}));

import { useRealtimeList } from "@/src/hooks/useRealtimeList";

type Status = (s: string, e?: Error) => void;
type FakeChannel = { on: () => FakeChannel; subscribe: (cb: Status) => FakeChannel; cb?: Status };

function fakeClient() {
  const channels: FakeChannel[] = [];
  const client = {
    channel: vi.fn(() => {
      const ch: FakeChannel = {
        on: () => ch,
        subscribe: (cb) => {
          ch.cb = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(async () => "ok"),
  };
  return { channels, sb: client as unknown as SupabaseClient };
}

const ref: { current: SupabaseClient | null } = { current: null };
let client: SupabaseClient | null = null;
const render = (sb: SupabaseClient, onRejoined: () => void) => {
  R.i = 0;
  R.effects = [];
  ref.current = client = sb;
  return useRealtimeList(sb, ref, "L", () => {}, onRejoined);
};
// The subscribe effect is the one that depends on the client.
const subscribe = () => R.effects.find((e) => e.deps?.includes(client))!.fn();

beforeEach(() => {
  R.slots = [];
  R.effects = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a channel that supabase-js rejoins by itself", () => {
  it("asks the page to catch up when the channel is back after an error", () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    subscribe();

    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).not.toHaveBeenCalled();
    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it.each(["TIMED_OUT", "CLOSED"])("catches up after %s too, once per rejoin", (lost) => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    render(sb, onRejoined);
    subscribe();

    channels[0].cb!(lost);
    channels[0].cb!("SUBSCRIBED");
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });

  it("asks the page to catch up when a channel set up by a reconnect comes back after an error", async () => {
    const { channels, sb } = fakeClient();
    const onRejoined = vi.fn();
    const { resubscribe } = render(sb, onRejoined);
    const done = resubscribe();
    channels[0].cb!("SUBSCRIBED");
    await done;
    expect(onRejoined).not.toHaveBeenCalled();

    channels[0].cb!("CHANNEL_ERROR", new Error("socket closed"));
    channels[0].cb!("SUBSCRIBED");
    expect(onRejoined).toHaveBeenCalledTimes(1);
  });
});
```

  If T1's fake channel needs more methods than `on`/`subscribe` (for example a `state` it reads to decide "joined"), copy them from the fake client in `__tests__/unit/realtime-cleanup.test.ts`, which T1 kept green.

  Run: `npx vitest run __tests__/unit/realtime-rejoin.test.ts`
  Expected: FAIL, 4 of 4 (`expected "spy" to be called 1 times, but got 0 times`).

- [ ] **Step 2: Detect a library rejoin in `useRealtimeList`.** In `src/hooks/useRealtimeList.ts`:

  Add below `const RESUBSCRIBE_TIMEOUT_MS = 10000;` (keep T1's constants):
```ts
// supabase-js rejoins a channel by itself after the socket drops and reports SUBSCRIBED
// again, but the database changes sent while it was away are never replayed. A SUBSCRIBED
// after CHANNEL_ERROR, TIMED_OUT or CLOSED on the same channel is such a rejoin.
function watchRejoin(onRejoined: () => void): (status: string) => void {
  let lost = false;
  return (status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      lost = true;
    } else if (status === "SUBSCRIBED" && lost) {
      lost = false;
      onRejoined();
    }
  };
}
```
  Add the param: in the `useRealtimeList(` signature, after `onChange: (change: RealtimeChange) => void` add `,\n  onRejoined?: () => void` (keep any params T1 added after it in their place, and put `onRejoined` last).
  Below the existing `onChangeRef` + its `useEffect`, add:
```ts
  const onRejoinedRef = useRef(onRejoined);
  useEffect(() => {
    onRejoinedRef.current = onRejoined;
  }, [onRejoined]);
```
  For **every** place that subscribes a channel, create a watcher for that channel right before its `.subscribe((status, err) => {` call, and make `rejoin(status);` the first statement of the status callback (before any early return). T1's draft has one such place, its `subscribe(client)` helper:
```ts
      subRef.current = sub;

      sub.channel.subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
```
  becomes
```ts
      subRef.current = sub;
      const rejoin = watchRejoin(() => onRejoinedRef.current?.());

      sub.channel.subscribe((status, err) => {
        rejoin(status);
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
```
  If T1 kept today's two places, change both. Today's resubscribe:
```ts
      let settled = false;
      const timeout = setTimeout(() => {
```
  becomes
```ts
      let settled = false;
      const rejoin = watchRejoin(() => onRejoinedRef.current?.());
      const timeout = setTimeout(() => {
```
  and
```ts
      channel.subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[RealtimeList] Resubscribe channel error:", status, "listId:", listId, err);
        }
        if (settled) return;
```
  becomes
```ts
      channel.subscribe((status, err) => {
        rejoin(status);
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[RealtimeList] Resubscribe channel error:", status, "listId:", listId, err);
        }
        if (settled) return;
```
  Today's initial subscribe:
```ts
      const channel = createChannel(supabaseClient, channelName);

      channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
```
  becomes
```ts
      const channel = createChannel(supabaseClient, channelName);
      const rejoin = watchRejoin(() => onRejoinedRef.current?.());

      channel.subscribe((status, err) => {
        rejoin(status);
        if (status === "SUBSCRIBED") {
```
  `rejoin(status)` must run before any early return (`if (settled) return;`, T1's `if (subRef.current !== sub) return;`), so a rejoin after the reconnect's own subscribe settled is still seen. `__tests__/unit/realtime-subscribe-logging.test.ts` (as T1 left it) keeps passing: the callbacks still start with `(status, err) => {` and still warn on `CHANNEL_ERROR`/`TIMED_OUT` with `err`.

- [ ] **Step 3: Pass `onRejoined` through `useListRealtime`.** In `src/hooks/useListRealtime.ts`:
  Replace
```ts
  onListDeleted: () => void;
}
```
  with
```ts
  onListDeleted: () => void;
  /** The channel came back after a drop: events sent meanwhile are lost, so the page catches up. */
  onRejoined?: () => void;
}
```
  Replace
```ts
  onListDeleted,
}: UseListRealtimeParams) {
```
  with
```ts
  onListDeleted,
  onRejoined,
}: UseListRealtimeParams) {
```
  Replace
```ts
  return useRealtimeList(supabaseClient, supabaseClientRef, listId, onChange);
```
  with
```ts
  return useRealtimeList(supabaseClient, supabaseClientRef, listId, onChange, onRejoined);
```

- [ ] **Step 4: Run the rejoin tests and see them pass.**
  Run: `npx vitest run __tests__/unit/realtime-rejoin.test.ts __tests__/unit/realtime-cleanup.test.ts __tests__/unit/realtime-subscribe-logging.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing helper and orchestrator tests.** Create `__tests__/unit/reconnect-catch-up.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rejoinThenRefresh } from "@/src/hooks/useReconnectOrchestrator";

// The reconnect's last two steps: rejoin realtime, then refresh over HTTP.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("rejoinThenRefresh", () => {
  it("still refreshes when the rejoin fails, then reports the failure so the reconnect retries", async () => {
    const calls: string[] = [];
    const down = new Error("Resubscribe timed out");
    const rejoin = async () => {
      calls.push("rejoin");
      throw down;
    };
    const refresh = async () => {
      calls.push("refresh");
    };

    await expect(rejoinThenRefresh(rejoin, refresh)).rejects.toBe(down);
    expect(calls).toEqual(["rejoin", "refresh"]);
    expect(console.warn).toHaveBeenCalledWith("[Orchestrator] Rejoin failed, refreshing over HTTP anyway:", down);
  });

  it("reports a failed refresh", async () => {
    const refused = new Error("Background refresh failed: 503");
    await expect(rejoinThenRefresh(async () => {}, async () => { throw refused; })).rejects.toBe(refused);
  });

  it("rejoins, then refreshes, and resolves when both work", async () => {
    const calls: string[] = [];
    await rejoinThenRefresh(async () => { calls.push("rejoin"); }, async () => { calls.push("refresh"); });
    expect(calls).toEqual(["rejoin", "refresh"]);
  });

  it("skips a step no page registered", async () => {
    const refresh = vi.fn(async () => {});
    await rejoinThenRefresh(null, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(rejoinThenRefresh(async () => {}, null)).resolves.toBeUndefined();
  });
});
```

  Create `__tests__/unit/reconnect-steps.test.ts`:

```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useReconnectOrchestrator with a slot-based stand-in for React: state and refs
// persist across calls, callbacks are returned as given, effects are not run (the test calls
// reconnect() itself). Timers are faked so the 2 s retry does not fire.
type Slot = { value?: unknown; current?: unknown };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: init };
    const slot = R.slots[i];
    return [slot.value, (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; }];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { current: init };
    return R.slots[i];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useEffect: () => { R.i++; },
}));

import { useReconnectOrchestrator } from "@/src/hooks/useReconnectOrchestrator";

type Params = Parameters<typeof useReconnectOrchestrator>[0];

const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// A healthy Mini App session whose list page registered its three steps.
function session(steps: { rejoin: () => Promise<void>; refresh: () => Promise<void> }) {
  const params = {
    fetchToken: async () => ({ kind: "ok", token: "jwt" }),
    clearJwt: () => {},
    jwtRef: { current: "jwt" },
    syncRealtime: () => {},
    isWebAppRef: { current: false },
    onFlushNeededRef: { current: async () => {} },
    onResubscribeNeededRef: { current: steps.rejoin },
    onRefreshNeededRef: { current: steps.refresh },
    router: { push: () => {} },
  } as unknown as Params;
  const render = () => {
    R.i = 0;
    return useReconnectOrchestrator(params);
  };
  // The launch sign-in ends the "initializing" state; reconnect() waits for it.
  const launch = async () => {
    await render().startSession();
    await settle();
  };
  return { render, launch };
}


beforeEach(() => {
  R.slots = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a reconnect whose realtime rejoin fails", () => {
  it("still refreshes the list over HTTP and keeps reporting that it is reconnecting", async () => {
    const refresh = vi.fn(async () => {});
    const s = session({ rejoin: async () => { throw new Error("Resubscribe timed out"); }, refresh });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(s.render().connectionStatus).toBe("connecting");
  });
});

describe("a reconnect whose refresh fails", () => {
  it("does not report connected", async () => {
    const s = session({ rejoin: async () => {}, refresh: async () => { throw new Error("Background refresh failed: 503"); } });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(s.render().connectionStatus).toBe("connecting");
  });

  it("reports connected when every step works", async () => {
    const s = session({ rejoin: async () => {}, refresh: async () => {} });
    await s.launch();
    s.render().reconnect();
    await settle();

    expect(s.render().connectionStatus).toBe("connected");
  });
});
```

  `session()` is a healthy Mini App session as T1's draft orchestrator takes it: `fetchToken` resolves a `TokenResult`, `syncRealtime` replaces `recreateSupabaseClient`, the token `"jwt"` has no `iat` so the token step asks `fetchToken` (answered ok), and `startSession()` ends the "initializing" state that `reconnect()` waits for. If T1's final orchestrator names these differently, use its names with the same meaning (a token request that succeeds, a no-op realtime sync, the launch sign-in that ends initialization); if T1 wrote an orchestrator test harness, build `session()` from it.

  Run: `npx vitest run __tests__/unit/reconnect-catch-up.test.ts __tests__/unit/reconnect-steps.test.ts`
  Expected: FAIL. `reconnect-catch-up`: every test (`rejoinThenRefresh is not a function`). `reconnect-steps`: "still refreshes the list over HTTP and keeps reporting that it is reconnecting" (`expected "spy" to be called 1 times, but got 0 times`). The two "a reconnect whose refresh fails" tests pass already: the orchestrator already treats a thrown refresh as a failed attempt; what was missing is `refreshItems` throwing (Step 8).

- [ ] **Step 6: Add `rejoinThenRefresh` and use it.** In `src/hooks/useReconnectOrchestrator.ts`, add above `function mapToConnectionStatus(`:
```ts
/**
 * Reconnect steps "rejoin" and "refresh". The refresh runs even when the rejoin failed, so the
 * screen catches up over HTTP while realtime is down. The rejoin's error is thrown afterwards,
 * so the orchestrator still counts the attempt and retries. A failed refresh throws too.
 */
export async function rejoinThenRefresh(
  rejoin: (() => Promise<void>) | null,
  refresh: (() => Promise<void>) | null
): Promise<void> {
  let rejoinFailed = false;
  let rejoinError: unknown;
  if (rejoin) {
    try {
      await rejoin();
    } catch (err) {
      console.warn("[Orchestrator] Rejoin failed, refreshing over HTTP anyway:", err);
      rejoinFailed = true;
      rejoinError = err;
    }
  }
  if (refresh) await refresh();
  if (rejoinFailed) throw rejoinError;
}
```
  In `runReconnect`, the rejoin step and the refresh step that follows it. In T1's draft (today the first comment reads "Step 3: Resubscribe realtime (no-op if no list page mounted)"):
```ts
      // Step 3: Rejoin realtime if the channel is not joined (no-op if no list page mounted)
      if (onResubscribeNeededRef.current) {
        await onResubscribeNeededRef.current();
      }

      // Step 4: Refresh server state (home page or list page)
      if (onRefreshNeededRef.current) {
        await onRefreshNeededRef.current();
      }
```
  Replace them with
```ts
      // Steps 3 and 4: rejoin realtime if the channel is not joined (no-op if no list page
      // mounted), then refresh server state (home page or list page), even when the rejoin failed.
      await rejoinThenRefresh(onResubscribeNeededRef.current, onRefreshNeededRef.current);
```
  (T1's draft checks "joined" inside the page's `resubscribe`, so nothing else changes.) If T1 guards the rejoin with a condition in the orchestrator (for example "only if the channel is not joined"), pass the step only when the condition holds: `await rejoinThenRefresh(<T1's condition> ? onResubscribeNeededRef.current : null, onRefreshNeededRef.current);`. The flush step before it and the success/cooldown code after it stay as T1 wrote them.

- [ ] **Step 7: Update the existing refresh-failure test to the new contract and add the network case.** In `__tests__/unit/list-data-categories.test.ts` replace
```ts
  it("a failed background refresh is logged with its status and keeps the items", async () => {
    stubRoutes({});
    await render().fetchItems();
    stubRoutes({ items: 502 });
    await expect(render().refreshItems()).resolves.toBeUndefined();
    expect(render().items.map((i) => i.id)).toEqual(["a"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Background refresh failed:", { listId: "L", status: 502 });
  });
```
  with
```ts
  it("a failed background refresh is logged with its status, keeps the items and throws so the reconnect retries", async () => {
    stubRoutes({});
    await render().fetchItems();
    stubRoutes({ items: 502 });
    await expect(render().refreshItems()).rejects.toThrow("Background refresh failed: 502");
    expect(render().items.map((i) => i.id)).toEqual(["a"]);
    expect(console.error).toHaveBeenCalledWith(
      "[List] Background refresh error:",
      { listId: "L" },
      expect.objectContaining({ message: "Background refresh failed: 502" })
    );
  });

  it("a background refresh that never reaches the server is logged, keeps the items and throws", async () => {
    stubRoutes({});
    await render().fetchItems();
    const offline = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn(async () => { throw offline; }));
    await expect(render().refreshItems()).rejects.toBe(offline);
    expect(render().items.map((i) => i.id)).toEqual(["a"]);
    expect(console.error).toHaveBeenCalledWith("[List] Background refresh error:", { listId: "L" }, offline);
  });
```
  Run: `npx vitest run __tests__/unit/list-data-categories.test.ts`
  Expected: FAIL, both tests (`promise resolved "undefined" instead of rejecting`).

- [ ] **Step 8: Make `refreshItems` throw.** In `src/hooks/useListData.ts` (as left by 4a) replace
```ts
      if (!res.ok) {
        console.warn("[List] Background refresh failed:", { listId, status: res.status });
        return;
      }
      const { items: fetchedItems } = await res.json();
```
  (inside `refreshItems`; `fetchItems` and `retrySorting` keep theirs) with
```ts
      // A failed refresh throws, so the reconnect orchestrator retries instead of reporting a
      // stale screen as connected.
      throwIfNotOk(res, "Background refresh");
      const { items: fetchedItems } = await res.json();
```
  and replace
```ts
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
    }
  }, [jwtRef, listId, listType, loadCategories]);
```
  (the end of `refreshItems`) with
```ts
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
      throw e;
    }
  }, [jwtRef, listId, listType, loadCategories]);
```
  The finished `refreshItems` reads:
```ts
  const refreshItems = useCallback(async () => {
    const jwt = jwtRef.current;
    if (!jwt) return;
    const base = itemsRef.current;
    try {
      const res = await fetch(`/api/lists/${listId}/items${ITEMS_URL_SUFFIX}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // A failed refresh throws, so the reconnect orchestrator retries instead of reporting a
      // stale screen as connected.
      throwIfNotOk(res, "Background refresh");
      const { items: fetchedItems } = await res.json();

      const mapped: ItemData[] = (fetchedItems || []).map((item: Record<string, unknown> & { users?: { name?: string }; editor?: { name?: string }; id: string }) => {
        return {
          ...item,
          creator_name: item.users?.name ?? null,
          editor_name: item.editor?.name ?? null,
          _pending: false,
          users: undefined,
          editor: undefined,
        };
      });
      // Merge, never replace: a change the server hasn't confirmed keeps its fields on screen.
      const engine = getSyncEngine(listId);
      setItems((prev) => mergeRefresh(prev, base, mapped, (id) => engine.pendingFields(id)));
      if (listType === "grocery") await loadCategories();
    } catch (e) {
      console.error("[List] Background refresh error:", { listId }, e);
      throw e;
    }
  }, [jwtRef, listId, listType, loadCategories]);
```

- [ ] **Step 9: Write the failing page test for the rejoin.** Append to `__tests__/unit/list-merge-wiring.test.ts`:

```ts

describe("the list page after a realtime rejoin", () => {
  it("refreshes the list to catch up on what it missed", async () => {
    S.realtimeArgs!.onRejoined!();
    await settle();
    expect(S.refreshCalls).toBe(1);
  });

  it("logs a catch-up refresh that fails", async () => {
    const refused = new Error("Background refresh failed: 503");
    S.refreshFails = refused;
    S.realtimeArgs!.onRejoined!();
    await settle();
    expect(console.error).toHaveBeenCalledWith("[List] Catch-up refresh after a realtime rejoin failed:", refused);
  });
});
```

  Run: `npx vitest run __tests__/unit/list-merge-wiring.test.ts`
  Expected: FAIL, both new tests (`S.realtimeArgs.onRejoined is not a function`).

- [ ] **Step 10: The page catches up after a rejoin, and no caller of `refreshItems` lets its throw escape.** In `app/(app)/list/[id]/page.tsx`, next to T3's `refreshAfterDrop` (before `onMutationError`), add:
```ts
  // supabase-js rejoined the list's channel after a drop: what changed meanwhile never
  // arrived, so re-read the list. Rejoins during a refresh share one more refresh after it.
  const refreshAfterRejoin = useMemo(
    () => coalesce(refreshItems, "[List] Catch-up refresh after a realtime rejoin failed"),
    [refreshItems]
  );
```
  In the `useListRealtime({ … })` call, add `onRejoined: refreshAfterRejoin,` after `onListDeleted,`.
  `coalesce` (T3, `src/utils/coalesce.ts`) catches and logs a failed run, so T3's `refreshAfterDrop` already survives `refreshItems` throwing. If T3's final page has no `coalesce`, create `src/utils/coalesce.ts` with:
```ts
/**
 * Wraps an async task so calls made while it runs collapse into one more run after it
 * finishes. A failed run is logged with `failureLog` (e.g. "[List] Refresh failed") and
 * never rejects.
 */
export function coalesce(task: () => Promise<void>, failureLog: string): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    do {
      again = false;
      try {
        await task();
      } catch (err) {
        console.error(`${failureLog}:`, err);
      }
    } while (again);
    running = false;
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    void run();
  };
}
```
  import it in the page (`import { coalesce } from "@/src/utils/coalesce";`), and route T3's refresh after a dropped change through it the same way (`coalesce(refreshItems, "[List] Refresh after a dropped change failed")`), adding the file to this commit.
  Then run `grep -rn "refreshItems" app src components`: besides `useListData` itself, the only uses must be the page's destructuring, the `coalesce(refreshItems, …)` wrappers, and `onRefreshNeededRef.current = refreshItems` (plus its effect deps). Wrap any other caller in a `coalesce` the same way.

- [ ] **Step 11: Run everything.**
  - `npx vitest run __tests__/unit/realtime-rejoin.test.ts __tests__/unit/reconnect-catch-up.test.ts __tests__/unit/reconnect-steps.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-merge-wiring.test.ts` → PASS.
  - `npx vitest run` → all green (`no-silent-catches` included: the new catch in `rejoinThenRefresh` logs the error).
  - `npx tsc --noEmit` → no errors.
  - `npx eslint src/hooks/useRealtimeList.ts src/hooks/useListRealtime.ts src/hooks/useListData.ts src/hooks/useReconnectOrchestrator.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/realtime-rejoin.test.ts __tests__/unit/reconnect-catch-up.test.ts __tests__/unit/reconnect-steps.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-merge-wiring.test.ts` → clean.

- [ ] **Step 12: Make each check bite** (remove, run, see red, restore, see green):
  1. Delete `rejoin(status);` from the status callback. With T1's single callback, all 4 `realtime-rejoin` tests go red. With today's two callbacks, check each: without it in the initial-subscribe callback, "asks the page to catch up when the channel is back after an error" and both "catches up after …" go red.
  2. With today's two callbacks only: delete `rejoin(status);` from the resubscribe callback → "asks the page to catch up when a channel set up by a reconnect comes back after an error" red.
  3. `watchRejoin`: replace `status === "SUBSCRIBED" && lost` with `status === "SUBSCRIBED"` → all 4 `realtime-rejoin` tests red (a first join would refresh).
  4. `watchRejoin`: delete `lost = false;` → "catches up after TIMED_OUT too, once per rejoin" and "… CLOSED …" red.
  5. `rejoinThenRefresh`: replace the `try { await rejoin(); } catch … { … }` block with `await rejoin();` → `reconnect-catch-up` "still refreshes when the rejoin fails, …" red.
  6. `rejoinThenRefresh`: delete `if (rejoinFailed) throw rejoinError;` → same test red.
  7. Orchestrator: put the two sequential steps back (`if (onResubscribeNeededRef.current) await onResubscribeNeededRef.current();` then the refresh) → `reconnect-steps` "still refreshes the list over HTTP and keeps reporting that it is reconnecting" red.
  8. `refreshItems`: replace `throwIfNotOk(res, "Background refresh");` with `if (!res.ok) return;` → `list-data-categories` "a failed background refresh is logged with its status, keeps the items and throws …" red.
  9. `refreshItems`: delete `throw e;` → both `list-data-categories` refresh-failure tests red.
  10. Page: remove `onRejoined: refreshAfterRejoin,` from the `useListRealtime` call → both `list-merge-wiring` rejoin tests red.

- [ ] **Step 13: Commit.**
```bash
git add src/hooks/useRealtimeList.ts src/hooks/useListRealtime.ts src/hooks/useListData.ts src/hooks/useReconnectOrchestrator.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/realtime-rejoin.test.ts __tests__/unit/reconnect-catch-up.test.ts __tests__/unit/reconnect-steps.test.ts __tests__/unit/list-data-categories.test.ts __tests__/unit/list-merge-wiring.test.ts
# only if Step 10 had to create it:
git add src/utils/coalesce.ts
git commit -m "$(cat <<'MSG'
fix(sync): catch up after a realtime rejoin; a reconnect never claims a stale screen

supabase-js rejoins a dropped channel by itself and the changes sent meanwhile were never
shown: a SUBSCRIBED after an error, timeout or close now refreshes the list. A reconnect
refreshes over HTTP even when the realtime rejoin failed, then still retries, and a
refresh the server refuses throws so the banner keeps saying it is reconnecting.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
MSG
)"
```

### Task 5: Undo, bulk scope and small fixes

Three sub-tasks, each green and committed before the next: **5a** list item handlers (H6, H11 client, H13, H14), **5b** Home (H16, H21), **5c** list metadata and the unavailable list (H22). Spec: `docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md` §3 (Undo bullets), §5 (bulk scope, client side), §6.

**What T1–T4 already changed in the files this task touches (anchor on code meaning, not line numbers):**
- T1 moved `app/page.tsx` → `app/(app)/page.tsx` and `app/list/[id]/page.tsx` → `app/(app)/list/[id]/page.tsx`, removed the `TelegramProvider` wrapper from both default exports, keyed the first load on the JWT, and put `<OfflineIndicator />` into the skeleton/error states. T1 also updated the import paths and the `HomeContent` / `ListContent` extraction in `home-background-saves.test.ts`, `home-fetch-lists.test.ts` and `list-type-switch.test.ts`. Line numbers in the tables below are today's (pre-T1) ones.
- T3 removed every inline `execute` closure from `src/hooks/useItemHandlers.ts` (so `addMutation` takes only `{ id, type, payload }`), moved the create follow-up into the page's success handler, added `at` to toggle/skip/order payloads, and added the `"restore"` case to `src/utils/executor-factory.ts` (PATCH `{ itemId, deleted_at: null }`, verb `Restore`). The engine lives in `src/sync/engine.ts`.
- T4 changed `refreshItems` in `src/hooks/useListData.ts` (pendingFields overlay) and the items INSERT/UPDATE branches of `src/hooks/useListRealtime.ts`, and may have added parameters to `useListRealtime` and to the list page's `useListRealtime({...})` call. T5 touches only `fetchItems` in useListData and only the `lists` branch of useListRealtime.
- T2 made `POST /api/lists/[id]/items/clear-completed` and `/unmark-completed` require `{ itemIds: string[] }` (uuid, 1..500) and act only on those ids that still match.

---

### Task 5a: Undo through the queue, scoped bulk actions, Remove duplicates, typed recycle

**Files:**
- Modify: `src/hooks/useItemHandlers.ts`
- Modify: `src/utils/search-completed-items.ts`
- Test (modify): `__tests__/unit/list-background-saves.test.ts`, `__tests__/unit/search-completed-items.test.ts`
- Test (create): `__tests__/unit/undo-delete-queued.test.ts`

**Interfaces:**
- Consumes (T3): `addMutation(m: { id: string; type: string; payload: Record<string, unknown> }): void` (useItemHandlers param), executor-factory case `"restore"` with payload `{ listId, itemId }`, `getSyncEngine(listId): SyncEngine` with `attach(handlers: EngineHandlers): () => void`, `add(m)`, `flush(): Promise<void>` (test only). Chain key = `payload.itemId`, so a `restore` waits behind the `delete` of the same item.
- Consumes (T2): clear-completed / unmark-completed POST body `{ itemIds: string[] }`.
- Produces: `export function findCompletedExactMatch(items: ItemData[], text: string, exclude?: ReadonlySet<string>): Suggestion | undefined` in `src/utils/search-completed-items.ts`. Queued mutation `{ type: "restore", payload: { listId: string; itemId: string } }` from the item-delete Undo and the Remove-duplicates Undo.

**Holes:**

| hole | root cause in code (today) | change | test that proves it |
|---|---|---|---|
| H6 | `useItemHandlers.ts:252-264` Undo of a delete calls `restoreOrRevert` → `restoreItemsOnServer` (direct PATCH outside the queue), so a delete kept for retry or still in flight lands after it; `:247` the 200 ms removal timer is never cleared, so an Undo inside it is removed again; `:533-546` same for Remove duplicates | Undo queues `{ type: "restore", payload: { listId, itemId } }` (one per duplicate); the removal timer is kept and cleared in Undo, and Undo replaces any exiting copy | `undo-delete-queued.test.ts` (real engine + executor factory: 503, in-flight, offline, duplicates); `list-background-saves.test.ts` "Undo of a delete queues a restore…", "an Undo inside the exit animation…", "Undo of a duplicates removal queues one restore…" |
| H11 (client) | `useItemHandlers.ts:606-611` and `:676-681` POST with no body, so the server acts on every completed row | send `{ itemIds }` = the ids the screen cleared/unmarked minus `temp-` ids; no request when none are left; the clear's Undo restores on the server only the ids it sent | `list-background-saves.test.ts` "Clear completed and Unmark all act only on what the screen showed" (4 tests), "Undo of a clear restores on the server only what the clear sent…" |
| H13 | `useItemHandlers.ts:518-520` sorts matches by position only | sort active rows first (`isActiveItem`), then position | `list-background-saves.test.ts` "Remove duplicates keeps the active copy" (3 tests) |
| H14 | `useItemHandlers.ts:179-189` a typed add (and each comma segment) always creates; only a suggestion tap (`components/AddItemInput.tsx:60`) sends `recycleId` | each segment with an exact normalized match among the completed suggestions recycles it through the existing `recycle` mutation (each completed item at most once per add) | `list-background-saves.test.ts` "a typed add recycles a completed item with the same text" (4 tests); `search-completed-items.test.ts` "findCompletedExactMatch" (3 tests) |

README needs no change: "completed items are recycled instead of duplicated" (README.md:29) becomes true for typed adds.

- [ ] **Step 1: Update the list-page harness so it records what the handlers queue**

In `__tests__/unit/list-background-saves.test.ts`, inside `function world(initial: ItemData[])`:

Current:
```ts
  const sent: { key: string; body: unknown }[] = [];
```
Replacement:
```ts
  const sent: { key: string; body: unknown }[] = [];
  // What the handlers queued, in order: "<type> <itemId | recycleId | text>".
  const queued: string[] = [];
```

Current (in the `h` helper's `useItemHandlers({...})` call; after T3 it is still a no-op):
```ts
      addMutation: () => {},
```
Replacement:
```ts
      addMutation: (m) => {
        const p = m.payload;
        queued.push(`${m.type} ${p.itemId ?? p.recycleId ?? p.text}`);
      },
```

Current (the object `world` returns):
```ts
    errorToast: () => errorToast,
    sent,
  };
```
Replacement:
```ts
    errorToast: () => errorToast,
    sent,
    queued,
  };
```

- [ ] **Step 2: Replace the Undo tests that encode the old direct-PATCH restore**

In `describe("Undo restores on the list page", ...)`, these three tests assert the old behavior (a direct `PATCH {deleted_at:null}` and a client-side revert). After this task a failed restore is the queue's job: a dropped one shows `items.syncError` and refreshes the list through the page's `onMutationError` (T3), a kept one is retried. They are replaced, not deleted.

Current:
```ts
  it("Undo of a delete whose restore fails takes the item off the screen again and says so", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    w.when("PATCH b", 500);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200); // the exit animation
    expect(w.ids()).toEqual(["a"]);
    w.undoAction()!.undo();
    expect(w.ids()).toEqual(["a", "b"]);
    await settle();

    expect(w.sent).toContainEqual({ key: "PATCH b", body: { itemId: "b", deleted_at: null } });
    expect(w.ids()).toEqual(["a"]);
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "b" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
  });

  it("Undo of a delete whose restore lands keeps the item, with no error", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.errorToast()).toBeNull();
  });

  it("Undo of a duplicates removal takes off again only the duplicate whose restore failed", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);
    w.when("PATCH m3", 500);

    w.h().handleRemoveDuplicates("milk");
    expect(w.ids()).toEqual(["m1"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["m1", "m2"]);
    expect(w.errorToast()).toBe("items.syncError");
  });
```
Replacement:
```ts
  // A failed restore is the queue's job now: a dropped one shows items.syncError and
  // refreshes the list (onMutationError), a kept one is retried. See undo-delete-queued.test.ts.
  it("Undo of a delete queues a restore behind the delete instead of sending its own PATCH", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200); // the exit animation
    expect(w.ids()).toEqual(["a"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.queued).toEqual(["delete b", "restore b"]);
    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.errorToast()).toBeNull();
  });

  it("an Undo inside the exit animation keeps the item on screen, once", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    w.undoAction()!.undo(); // before the 200 ms removal fires
    await vi.advanceTimersByTimeAsync(500);

    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.item("b")?._exiting).toBeFalsy();
    expect(w.queued).toEqual(["delete b", "restore b"]);
  });

  it("Undo of a duplicates removal queues one restore per removed duplicate", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);

    w.h().handleRemoveDuplicates("milk");
    expect(w.ids()).toEqual(["m1"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.queued).toEqual(["delete m2", "delete m3", "restore m2", "restore m3"]);
    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual(["m1", "m2", "m3"]);
  });
```

In the same describe, insert this test directly before `it("Undo of a clear takes off again only the items whose restore failed", ...)`:
```ts
  it("Undo of a clear restores on the server only what the clear sent; an unsaved item just comes back", async () => {
    const w = world([
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleClearCompleted();
    w.undoAction()!.undo();
    await settle();

    expect(w.sent.map((s) => s.key)).toEqual(["POST clear-completed", "PATCH b"]);
    expect(w.ids()).toEqual(["b", "temp-x"]);
    expect(w.errorToast()).toBeNull();
  });
```

- [ ] **Step 3: Add the H11, H13 and H14 tests**

In `__tests__/unit/list-background-saves.test.ts`, insert these three describes directly before the line `type El = ReactElement<Record<string, unknown> & { children?: unknown }>;`:
```ts
describe("Clear completed and Unmark all act only on what the screen showed", () => {
  it("Clear completed sends the ids it cleared: no parked recurring item, no unsaved item", async () => {
    const w = world([
      item({ id: "a" }),
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "c", completed: true, completed_at: DONE_B }),
      item({ id: "r", completed: true, completed_at: DONE_A, recurring: true }),
      item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleClearCompleted();

    expect(w.sent).toEqual([{ key: "POST clear-completed", body: { itemIds: ["b", "c"] } }]);
    expect(w.ids()).toEqual(["a", "r"]);
  });

  it("Clear completed with only unsaved items sends nothing", async () => {
    const w = world([item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_A, _pending: true })]);

    await w.h().handleClearCompleted();

    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual([]);
    expect(w.undoAction()?.message).toBe("items.clearedCount");
  });

  it("Unmark all sends the ids it unmarked, without unsaved ones", async () => {
    const w = world([
      item({ id: "a", completed: true, completed_at: DONE_A }),
      item({ id: "b", completed: true, completed_at: DONE_B }),
      item({ id: "temp-y", text: "y", completed: true, completed_at: DONE_B, _pending: true }),
      item({ id: "c" }),
    ]);

    await w.h().handleUnmarkAllDone();

    expect(w.sent).toEqual([{ key: "POST unmark-completed", body: { itemIds: ["a", "b"] } }]);
    expect(w.item("temp-y")).toMatchObject({ completed: false, completed_at: null });
  });

  it("Unmark all with only unsaved items sends nothing", async () => {
    const w = world([item({ id: "temp-y", text: "y", completed: true, completed_at: DONE_A, _pending: true })]);

    await w.h().handleUnmarkAllDone();

    expect(w.sent).toEqual([]);
    expect(w.item("temp-y")).toMatchObject({ completed: false });
  });
});

describe("Remove duplicates keeps the active copy", () => {
  it("after a drag, when the done copy has the higher position", () => {
    const w = world([
      item({ id: "active-milk", text: "milk", position: 3 }),
      item({ id: "done-milk", text: "milk", position: 1730000000000, completed: true, completed_at: DONE_A }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued).toEqual(["delete done-milk"]);
    expect(w.ids()).toEqual(["active-milk"]);
  });

  it("when the done copy is the newer one", () => {
    const w = world([
      item({ id: "active-milk", text: "milk", position: 1729000000000 }),
      item({ id: "done-milk", text: "Milk", position: 1730000000000, completed: true, completed_at: DONE_A }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued).toEqual(["delete done-milk"]);
  });

  it("over a skipped copy, and keeps the higher position among active copies", () => {
    const w = world([
      item({ id: "skipped-milk", text: "milk", position: 9, skipped_at: DONE_A }),
      item({ id: "low-milk", text: "milk", position: 2 }),
      item({ id: "high-milk", text: "milk", position: 5 }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued.sort()).toEqual(["delete low-milk", "delete skipped-milk"]);
    expect(w.ids()).toEqual(["high-milk"]);
  });
});

describe("a typed add recycles a completed item with the same text", () => {
  it("Enter on a done item's text brings that item back instead of adding a second row", async () => {
    const w = world([item({ id: "done-milk", text: "milk", completed: true, completed_at: DONE_A })]);

    await w.h().handleAddItem("Milk");

    expect(w.queued).toEqual(["recycle done-milk"]);
    expect(w.ids()).toEqual(["done-milk"]);
    expect(w.item("done-milk")).toMatchObject({ completed: false, completed_at: null, created_by: "u" });
  });

  it("each comma segment recycles its match once; the rest are added", async () => {
    const w = world([item({ id: "done-milk", text: "milk", completed: true, completed_at: DONE_A })]);

    await w.h().handleAddItem("bread, milk, milk");

    expect(w.queued).toEqual(["create bread", "recycle done-milk", "create milk"]);
  });

  it("takes the most recently completed exact match; a substring match never recycles", async () => {
    const w = world([
      item({ id: "chocolate", text: "milk chocolate", completed: true, completed_at: "2026-10-22T08:00:00.000Z" }),
      item({ id: "old-milk", text: "milk", completed: true, completed_at: DONE_A }),
      item({ id: "new-milk", text: "milk", completed: true, completed_at: DONE_B }),
    ]);

    await w.h().handleAddItem("milk");
    await w.h().handleAddItem("chocolate");

    expect(w.queued).toEqual(["recycle new-milk", "create chocolate"]);
  });

  it("never recycles an active, deleted or unsaved row", async () => {
    const w = world([
      item({ id: "active-milk", text: "milk" }),
      item({ id: "gone-milk", text: "milk", completed: true, completed_at: DONE_A, deleted_at: DONE_B }),
      item({ id: "temp-milk", text: "milk", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleAddItem("milk");

    expect(w.queued).toEqual(["create milk"]);
  });
});
```

- [ ] **Step 4: Add the exact-match unit tests**

In `__tests__/unit/search-completed-items.test.ts`:

Current:
```ts
import { searchCompletedItems, computeSuggestions } from "@/src/utils/search-completed-items";
```
Replacement:
```ts
import { searchCompletedItems, computeSuggestions, findCompletedExactMatch } from "@/src/utils/search-completed-items";
```

Append at the end of the file:
```ts
describe("findCompletedExactMatch", () => {
  it("matches the whole text after normalization (case, curly quotes, spaces), never a substring", () => {
    const items = [item({ id: "cake", text: "Mom's cake" }), item({ id: "cakes", text: "mom's cake mix" })];
    expect(findCompletedExactMatch(items, "  mom’s   CAKE ")?.id).toBe("cake");
    expect(findCompletedExactMatch(items, "cake")).toBeUndefined();
    expect(findCompletedExactMatch(items, "   ")).toBeUndefined();
  });

  // The server recycles only an id among its own top ten (findRecyclableItems), so a match
  // further down would be refused there and inserted as a new row instead.
  it("looks only where the server looks: the ten most recently completed substring matches", () => {
    const newer = Array.from({ length: 10 }, (_, k) =>
      item({ id: `n${k}`, text: `milk ${k}`, completed_at: `2026-02-${String(k + 10)}T00:00:00+00:00` })
    );
    const exact = item({ id: "milk", text: "milk", completed_at: "2026-01-01T00:00:00+00:00" });
    expect(findCompletedExactMatch([...newer.slice(1), exact], "milk")?.id).toBe("milk");
    expect(findCompletedExactMatch([...newer, exact], "milk")).toBeUndefined();
  });

  it("skips excluded ids, falling back to the next most recently completed", () => {
    const items = [
      item({ id: "old", text: "milk", completed_at: "2026-01-01T00:00:00+00:00" }),
      item({ id: "new", text: "milk", completed_at: "2026-01-02T00:00:00+00:00" }),
    ];
    expect(findCompletedExactMatch(items, "milk")?.id).toBe("new");
    expect(findCompletedExactMatch(items, "milk", new Set(["new"]))?.id).toBe("old");
    expect(findCompletedExactMatch(items, "milk", new Set(["new", "old"]))).toBeUndefined();
  });
});
```

- [ ] **Step 5: Create the engine-level Undo test (the audit's repro: DELETE kept for retry, Undo, flush)**

Create `__tests__/unit/undo-delete-queued.test.ts`:
```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { getSyncEngine } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { ItemData } from "@/src/types";

function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// How the fake server answers one request: a status, a network failure, or held until released.
type Reply = number | "neterr" | "hold";
type Undo = { message: string; undo: () => void; timeout: NodeJS.Timeout } | null;

// The engine registry is module-level, one engine per list: every test gets a list of its own.
let lists = 0;

// The list page around the real handlers, the real engine and the real executor factory.
// The fake server keeps which items are soft-deleted; `log` is every request it answered,
// in order, as "<METHOD> <itemId> -> <status | neterr>".
function world(initial: ItemData[]) {
  const listId = `undo-${++lists}`;
  let items = initial;
  let undoAction: Undo = null;
  const deleted = new Set<string>();
  const replies = new Map<string, Reply[]>();
  // A request that keeps failing the same way until `up` (a retry while still down fails too).
  const failing = new Map<string, Reply>();
  const held = new Map<string, (status: number) => void>();
  const log: string[] = [];

  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const itemId = init.method === "DELETE" ? new URL(url, "http://app").searchParams.get("itemId")! : body.itemId;
    const key = `${init.method} ${itemId}`;
    const reply = failing.get(key) ?? replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") {
      log.push(`${key} -> neterr`);
      throw new TypeError("Failed to fetch");
    }
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    log.push(`${key} -> ${status}`);
    if (status === 200 && init.method === "DELETE") deleted.add(itemId);
    if (status === 200 && init.method === "PATCH" && body.deleted_at === null) deleted.delete(itemId);
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  }));

  const engine = getSyncEngine(listId);
  const onError = vi.fn();
  const detach = engine.attach({ getJwt: () => "jwt", executorFactory: createExecutorFactory(), onError });

  const h = () =>
    useItemHandlers({
      listId,
      jwtRef: { current: "jwt" },
      userId: "u",
      items,
      setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
      addMutation: (m) => engine.add(m),
      setUndoAction: (u) => { undoAction = typeof u === "function" ? u(undoAction) : u; },
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: () => {},
      t: (key) => key,
    });

  return {
    h,
    engine,
    detach,
    onError,
    log,
    deleted,
    when: (key: string, ...r: Reply[]) => replies.set(key, r),
    down: (key: string, reply: Reply) => failing.set(key, reply),
    up: (key: string) => failing.delete(key),
    release: (key: string, status: number) => held.get(key)!(status),
    undo: () => undoAction!.undo(),
    ids: () => items.map((i) => i.id).sort(),
  };
}

// The restore of `id` went out only after a delete of it had landed, and the item ended live.
function restoredAfterDelete(log: string[], deleted: Set<string>, id: string) {
  const landed = log.indexOf(`DELETE ${id} -> 200`);
  const firstPatch = log.findIndex((l) => l.startsWith(`PATCH ${id} `));
  expect(landed).toBeGreaterThan(-1);
  expect(firstPatch).toBeGreaterThan(landed);
  expect(log.slice(landed + 1).some((l) => l.startsWith(`DELETE ${id} `))).toBe(false);
  expect(deleted.has(id)).toBe(false);
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};

// A flush that may wait on timers of its own (backoff) still completes under fake timers.
const flushed = async (engine: { flush(): Promise<void> }) => {
  const done = engine.flush();
  await settle();
  await done;
  await settle();
};

let detach: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { onLine: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  detach?.();
  detach = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Undo of a delete always lands after the delete", () => {
  it("a delete kept for retry (503) is replayed before the restore, so the item stays on the server", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.down("DELETE b", 503);

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    // The restore waits behind the delete that is waiting for its retry.
    expect(w.log.some((l) => l.startsWith("PATCH b "))).toBe(false);

    w.up("DELETE b");
    await flushed(w.engine);

    expect(w.log[0]).toBe("DELETE b -> 503");
    restoredAfterDelete(w.log, w.deleted, "b");
    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.onError).not.toHaveBeenCalledWith(expect.objectContaining({ dropped: true }));
  });

  it("an Undo tapped while the delete is in flight is sent only after the delete answered", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.when("DELETE b", "hold");

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    expect(w.log).toEqual([]);

    w.release("DELETE b", 200);
    await settle();

    expect(w.log).toEqual(["DELETE b -> 200", "PATCH b -> 200"]);
    restoredAfterDelete(w.log, w.deleted, "b");
  });

  it("an Undo made offline is kept and replayed in order once the network is back", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.down("DELETE b", "neterr");
    w.down("PATCH b", "neterr");

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    expect(w.ids()).toEqual(["a", "b"]);

    w.up("DELETE b");
    w.up("PATCH b");
    await flushed(w.engine);

    expect(w.log[0]).toBe("DELETE b -> neterr");
    restoredAfterDelete(w.log, w.deleted, "b");
  });

  it("Undo of Remove duplicates restores each duplicate after its own delete", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);
    detach = w.detach;
    w.down("DELETE m2", 503);
    w.down("DELETE m3", 503);

    w.h().handleRemoveDuplicates("milk");
    await settle();
    w.undo();
    await settle();
    w.up("DELETE m2");
    w.up("DELETE m3");
    await flushed(w.engine);

    restoredAfterDelete(w.log, w.deleted, "m2");
    restoredAfterDelete(w.log, w.deleted, "m3");
    expect(w.ids()).toEqual(["m1", "m2", "m3"]);
  });
});
```

- [ ] **Step 6: Run the tests and see them fail**

Run: `npx vitest run __tests__/unit/list-background-saves.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/undo-delete-queued.test.ts`

Expected failures:
- `search-completed-items.test.ts`: the whole file fails to run, `findCompletedExactMatch` is not exported (TypeError: not a function).
- `list-background-saves.test.ts`: "Undo of a delete queues a restore…" (`queued` is `["delete b"]`, `sent` has `PATCH b`), "an Undo inside the exit animation…" (ids `["a"]`), "Undo of a duplicates removal queues one restore…", "Undo of a clear restores on the server only what the clear sent…" (a `PATCH temp-x` is sent), all four "act only on what the screen showed" tests (body `undefined`), the three "Remove duplicates keeps the active copy" tests (`delete active-milk`), and three of the four "typed add" tests (`create milk`).
- `undo-delete-queued.test.ts`: the three single-delete tests fail on `restoredAfterDelete` (the direct PATCH goes out before the delete lands, or fails offline and the item leaves the screen); the duplicates test fails the same way.

- [ ] **Step 7: Add `findCompletedExactMatch`**

In `src/utils/search-completed-items.ts`, current:
```ts
/**
 * Suggestions for the add-item input: searches only the text after the last comma.
```
Replacement:
```ts
/**
 * The completed item a typed add recycles: the same text after normalization (no
 * substring), most recently completed first, skipping ids in `exclude`. Picked from the
 * suggestions for that text (top 10), the set the server re-validates a recycle against,
 * so a typed add and a tap on the matching suggestion do the same thing.
 */
export function findCompletedExactMatch(
  items: ItemData[],
  text: string,
  exclude: ReadonlySet<string> = new Set()
): Suggestion | undefined {
  const canonical = normalizeForStorage(text);
  if (!canonical) return undefined;
  const needle = normalizeForCompare(canonical);
  return searchCompletedItems(items, canonical).find(
    (s) => !exclude.has(s.id) && normalizeForCompare(s.text) === needle
  );
}

/**
 * Suggestions for the add-item input: searches only the text after the last comma.
```
(It deliberately keeps `searchCompletedItems`' default limit of 10: the server's recycle re-validates `recycleId` against its own top ten `findRecyclableItems` rows, ordered the same way, so a match further down would be refused there and inserted as a new row while the screen showed it recycled.)

- [ ] **Step 8: Imports in `src/hooks/useItemHandlers.ts`**

Current:
```ts
import { genMutId } from "@/src/utils/list-helpers";
```
Replacement:
```ts
import { genMutId, isActiveItem } from "@/src/utils/list-helpers";
```
Current:
```ts
import { computeUnskipAll } from "@/src/utils/unskip-all";
```
Replacement:
```ts
import { computeUnskipAll } from "@/src/utils/unskip-all";
import { findCompletedExactMatch } from "@/src/utils/search-completed-items";
```
Keep the `restoreItemsOnServer` / `RestoreBody` import, `restoreOrRevert` and `removeAgain`: Clear completed and Unmark all still use them (call 4A, not queued).

- [ ] **Step 9: H14, typed add recycles**

Replace the whole `const handleAddItem = useCallback(...);` declaration (after T3 its recycle branch is `addMutation({ id: mutId, type: "recycle", payload: { listId, recycleId, text } })` with no `execute`) with the block below. The duplicate-warning lines are unchanged from today; if T3 or T4 changed a line outside the `if (recycleId) { … } else { … }` block, keep their version of that line. `addSingleItem` is not touched.
```ts
  // Brings a completed item back to the active list: the suggestion tap, and a typed add
  // whose text matches a completed item.
  const recycleCompleted = useCallback(
    (recycleId: string, text: string) => {
      setItems((prev) =>
        prev.map((i) =>
          i.id === recycleId
            ? { ...i, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, created_by: userId, creator_name: null }
            : i
        )
      );
      addMutation({ id: genMutId(), type: "recycle", payload: { listId, recycleId, text } });
    },
    [listId, addMutation, userId, setItems]
  );

  const handleAddItem = useCallback(
    async (text: string, recycleId?: string) => {
      // No JWT guard here — items are added optimistically and queued.
      // The executor reads jwtRef.current at execution time (after reconnect).

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

      if (recycleId) {
        recycleCompleted(recycleId, text);
      } else {
        // Split comma-separated items into individual mutations
        const segments = text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        // A typed item with the same text as a completed one recycles it, exactly like a
        // tap on its suggestion (owner decision 1, 2026-10-29 sync spec). Each completed
        // item is reused at most once per add, so "milk, milk" recycles one and adds one.
        const used = new Set<string>();
        for (const segment of segments) {
          const match = findCompletedExactMatch(items, segment, used);
          if (match) {
            used.add(match.id);
            recycleCompleted(match.id, match.text);
          } else {
            addSingleItem(segment);
          }
        }
      }
    },
    [addSingleItem, recycleCompleted, items, t, setDuplicateWarning]
  );
```

- [ ] **Step 10: H6, Undo of a delete goes through the queue**

Replace the whole `const handleDelete = useCallback(...);` declaration (T3 left it with `addMutation({ id: …, type: "delete", payload: { listId, itemId } })` and the `restoreOrRevert([{ itemId, deleted_at: null }], removeAgain)` Undo) with:
```ts
  const handleDelete = useCallback(
    async (itemId: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      const deletedItem = items.find((i) => i.id === itemId);
      // Animate out then remove. Kept so an Undo inside the animation can cancel it.
      setItems((prev) => prev.map((i) => i.id === itemId ? { ...i, _exiting: true } : i));
      const removal = setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== itemId)), 200);

      // Show undo toast
      const timeout = setTimeout(() => setUndoAction(null), 4000);

      setUndoAction({
        message: t('items.deleted'),
        undo: () => {
          clearTimeout(timeout);
          clearTimeout(removal);
          setUndoAction(null);
          if (deletedItem) {
            // Replaces the exiting copy when the Undo comes inside the animation.
            setItems((prev) => [...prev.filter((i) => i.id !== itemId), deletedItem]);
            // Queued on the item's chain, so it lands after the delete (in flight or kept
            // for retry) and replays offline like any other change.
            addMutation({ id: genMutId(), type: "restore", payload: { listId, itemId } });
          }
        },
        timeout,
      });

      addMutation({ id: genMutId(), type: "delete", payload: { listId, itemId } });
    },
    [listId, items, addMutation, t, setItems, setUndoAction]
  );
```

- [ ] **Step 11: H13 + H6, Remove duplicates keeps the active copy and its Undo goes through the queue**

Replace the whole `const handleRemoveDuplicates = useCallback(...);` declaration with:
```ts
  const handleRemoveDuplicates = useCallback(
    (text: string) => {
      const tg = getTelegramWebApp();
      tg?.HapticFeedback?.notificationOccurred("warning");

      // Find all non-deleted items matching text (normalized)
      const normalized = normalizeForCompare(text);
      // The active copy (the row whose badge was tapped) is kept, then the highest position.
      // Completed and skipped copies are history: a drag renumbers active rows 1..N while
      // done rows keep their large creation-time positions, so position alone would keep them.
      const matches = items
        .filter((i) => !i.deleted_at && normalizeForCompare(i.text) === normalized)
        .sort((a, b) => Number(isActiveItem(b)) - Number(isActiveItem(a)) || b.position - a.position);

      if (matches.length <= 1) return;

      // Keep the first match, remove the rest
      const duplicatesToRemove = matches.slice(1);
      const removeIds = new Set(duplicatesToRemove.map((i) => i.id));

      // Optimistic removal
      setItems((prev) => prev.filter((i) => !removeIds.has(i.id)));

      // Show undo toast
      const timeout = setTimeout(() => setUndoAction(null), 4000);
      setUndoAction({
        message: t("items.removedDuplicates", { count: duplicatesToRemove.length }),
        undo: () => {
          clearTimeout(timeout);
          setUndoAction(null);
          setItems((prev) => [...prev.filter((i) => !removeIds.has(i.id)), ...duplicatesToRemove]);
          // One restore per duplicate, each queued behind that duplicate's delete.
          for (const item of duplicatesToRemove) {
            addMutation({ id: genMutId(), type: "restore", payload: { listId, itemId: item.id } });
          }
        },
        timeout,
      });

      // Queue delete mutations
      for (const item of duplicatesToRemove) {
        addMutation({ id: genMutId(), type: "delete", payload: { listId, itemId: item.id } });
      }
    },
    [listId, items, addMutation, t, setItems, setUndoAction]
  );
```

- [ ] **Step 12: H11, Clear completed sends the shown ids**

T1–T4 do not touch `handleClearCompleted`. Current:
```ts
    const { cleared: completedItems } = computeClearCompleted(items);
    // Optimistic — recurring staples stay parked, not cleared (see
```
Replacement:
```ts
    const { cleared: completedItems } = computeClearCompleted(items);
    // The ids the screen showed: the server clears only these, never an item a collaborator
    // ticked a moment ago. An item still waiting for its offline create has a temp- id the
    // server doesn't know yet, so it is cleared on screen only.
    const itemIds = completedItems.map((i) => i.id).filter((id) => !id.startsWith("temp-"));
    // Optimistic — recurring staples stay parked, not cleared (see
```
Current:
```ts
        // Restore on server; items whose restore fails leave the screen again.
        restoreOrRevert(
          completedItems.map((item) => ({ itemId: item.id, deleted_at: null })),
```
Replacement:
```ts
        // Restore on server what the clear sent; items whose restore fails leave the screen again.
        restoreOrRevert(
          itemIds.map((itemId) => ({ itemId, deleted_at: null })),
```
Current:
```ts
    try {
      const res = await fetch(`/api/lists/${listId}/items/clear-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
```
Replacement:
```ts
    if (itemIds.length === 0) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items/clear-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
```

- [ ] **Step 13: H11, Unmark all sends the shown ids**

Current:
```ts
    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;
```
Replacement:
```ts
    const { affectedIds } = computeUnmarkCompleted(items);
    if (affectedIds.length === 0) return;
    // The ids the screen showed, as Clear completed sends them; temp- items are unmarked on
    // screen only.
    const itemIds = affectedIds.filter((id) => !id.startsWith("temp-"));
```
Current:
```ts
        restoreOrRevert(
          affectedIds.map((id) => ({ itemId: id, completed: true })),
```
Replacement:
```ts
        restoreOrRevert(
          itemIds.map((id) => ({ itemId: id, completed: true })),
```
Current:
```ts
    try {
      const res = await fetch(`/api/lists/${listId}/items/unmark-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      });
```
Replacement:
```ts
    if (itemIds.length === 0) return;
    try {
      const res = await fetch(`/api/lists/${listId}/items/unmark-completed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
```

- [ ] **Step 14: Run green**

Run: `npx vitest run __tests__/unit/list-background-saves.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/undo-delete-queued.test.ts` → all pass.
Run: `npx vitest run` → all pass (`no-silent-catches.test.ts` included; `mutation-request-parity.test.ts` / `executor-factory.test.ts` as T3 left them already cover `"restore"`).
Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint src/hooks/useItemHandlers.ts src/utils/search-completed-items.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/undo-delete-queued.test.ts` → clean (the `useCallback` deps above are exact; react-hooks flags any unnecessary one).

- [ ] **Step 15: Make it bite (remove each check, see the named test go red, restore)**

| remove | red test |
|---|---|
| in handleDelete's Undo, replace `addMutation({ id: genMutId(), type: "restore", payload: { listId, itemId } });` with `restoreOrRevert([{ itemId, deleted_at: null }], removeAgain);` (and add `restoreOrRevert, removeAgain` to deps) | `undo-delete-queued.test.ts` three single-delete tests; `list-background-saves` "Undo of a delete queues a restore…" |
| in handleRemoveDuplicates' Undo, replace the restore `addMutation` with `restoreOrRevert([{ itemId: item.id, deleted_at: null }], removeAgain);` | `undo-delete-queued` "Undo of Remove duplicates restores each duplicate…"; `list-background-saves` "Undo of a duplicates removal queues one restore…" |
| `clearTimeout(removal);` | "an Undo inside the exit animation keeps the item on screen, once" |
| `prev.filter((i) => i.id !== itemId)` in the Undo (use `[...prev, deletedItem]`) | "an Undo inside the exit animation…" (b twice) |
| `Number(isActiveItem(b)) - Number(isActiveItem(a)) \|\| ` | the three "Remove duplicates keeps the active copy" tests |
| `findCompletedExactMatch(...)` (use `undefined`) | three "typed add" tests |
| `used.add(match.id);` | "each comma segment recycles its match once…" |
| `&& normalizeForCompare(s.text) === needle` in the helper | "takes the most recently completed exact match…"; "findCompletedExactMatch > matches the whole text…" |
| pass `items.length` as the limit in the helper | "findCompletedExactMatch > looks only where the server looks…" |
| `body: JSON.stringify({ itemIds })` in Clear completed | "Clear completed sends the ids it cleared…" |
| `.filter((id) => !id.startsWith("temp-"))` in Clear completed | "Clear completed sends the ids…", "Clear completed with only unsaved items…", "Undo of a clear restores on the server only what the clear sent…" |
| `if (itemIds.length === 0) return;` in Clear completed | "Clear completed with only unsaved items sends nothing" |
| `itemIds.map(...)` in the clear's Undo (use `completedItems.map(...)`) | "Undo of a clear restores on the server only what the clear sent…" |
| `body: JSON.stringify({ itemIds })` / the temp filter / the empty return in Unmark all | "Unmark all sends the ids it unmarked…" / both Unmark tests / "Unmark all with only unsaved items sends nothing" |

- [ ] **Step 16: Commit**

```bash
git add src/hooks/useItemHandlers.ts src/utils/search-completed-items.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/search-completed-items.test.ts __tests__/unit/undo-delete-queued.test.ts
git commit -m "fix(items): undo goes through the queue, bulk actions send the shown ids, typed adds recycle

Undo of a delete and of Remove duplicates is a queued restore, so it lands
after the delete. Clear completed and Unmark all send the ids the screen
showed. Remove duplicates keeps the active copy. A typed item that matches a
completed one recycles it, as a suggestion tap does.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 5b: Home Undo ordered after the original request; auto-open at launch only; silent reconnect refresh

**Files:**
- Modify: `app/(app)/page.tsx`
- Test (modify): `__tests__/unit/home-background-saves.test.ts`, `__tests__/unit/home-fetch-lists.test.ts`

**Interfaces:**
- Consumes (T1): `useTelegram().onRefreshNeededRef` (orchestrator refresh slot), the moved page path.
- Produces: the orchestrator refresh Home registers is `() => fetchLists({ silent: true })` (plus whatever T4 added, see Step 6).

**Holes:**

| hole | root cause in code (today) | change | test that proves it |
|---|---|---|---|
| H16 | `app/page.tsx:241` the archive Undo posts `!archived` without waiting for `post(archived)` at `:254`; `:419-434` the delete Undo's restore PATCH is not chained on the DELETE at `:440-453` | keep each original request as a promise that settles `true` (landed) / `false` (failed, handler already ran); the Undo sends only after it, and only when it landed | `home-background-saves.test.ts` "an Undo tapped while the archive is in flight unarchives only after…", "an archive that fails after Undo was tapped…", "an Undo tapped while the delete is in flight restores only after…", "a delete that fails after Undo was tapped shows the card once and sends no restore" |
| H21 | `app/page.tsx:151-153` the else branch removes the `autoOpenedSingleList` flag, re-arming auto-open on any later load; `:286` the orchestrator gets `fetchLists` itself (non-silent); `:133-137` a silent success never clears `error` | the first active-view load sets the flag whatever the count; register `() => fetchLists({ silent: true })`; `setError(false)` on every successful load | `home-background-saves.test.ts` "single-list auto-open happens at launch only" (3) and "a reconnect refresh never shows the full-page error" (2); `home-fetch-lists.test.ts` first test updated |

- [ ] **Step 1: Let the Home harness see request bodies and route pushes**

In `__tests__/unit/home-background-saves.test.ts` (as T1 left it):

Current (in `const H = vi.hoisted(...)`):
```ts
  router: { push: () => {} },
```
Replacement:
```ts
  router: { push: (() => {}) as (url: string) => void },
```
Current:
```ts
let calls: string[];
```
Replacement:
```ts
let calls: string[];
let sentBodies: { key: string; body: unknown }[];
```
Current (in `beforeEach`):
```ts
  calls = [];
  const storage = () => {
```
Replacement:
```ts
  calls = [];
  sentBodies = [];
  H.router.push = () => {};
  const storage = () => {
```
Current (in `beforeEach`):
```ts
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
```
Replacement:
```ts
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    if (init?.body) sentBodies.push({ key, body: JSON.parse(init.body) });
```

- [ ] **Step 2: H16 tests**

In `describe("Home: delete a list", ...)`, current:
```ts
  it("a delete that fails after Undo was tapped shows the card once", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["hold"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();
    held.get("DELETE /api/lists?id=B")!(500);
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()?.message).toBe("lists.deleteFailed");
  });
```
Replacement:
```ts
  it("a delete that fails after Undo was tapped shows the card once and sends no restore", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["hold"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onDelete");
    toast()!.undo!();
    expect(listIds()).toEqual(["A", "B", "C"]);
    await settle();
    held.get("DELETE /api/lists?id=B")!(500);
    await settle();

    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()?.message).toBe("lists.deleteFailed");
    expect(calls).not.toContain("PATCH /api/lists");
  });

  it("an Undo tapped while the delete is in flight restores only after the delete landed", async () => {
    await boot();
    replies.set("DELETE /api/lists?id=B", ["hold"]);

    press(card("B"), "onDelete");
    toast()!.undo!();
    await settle();
    expect(calls).not.toContain("PATCH /api/lists");

    held.get("DELETE /api/lists?id=B")!(200);
    await settle();

    expect(calls.slice(-2)).toEqual(["DELETE /api/lists?id=B", "PATCH /api/lists"]);
    expect(sentBodies).toContainEqual({ key: "PATCH /api/lists", body: { id: "B", restore: true } });
    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toBeNull();
  });
```

Current:
```ts
describe("Home: Undo of an archive", () => {
```
Replacement:
```ts
describe("Home: Undo of an archive", () => {
  it("an Undo tapped while the archive is in flight unarchives only after the archive landed", async () => {
    await boot();
    replies.set("POST /api/lists/archive", ["hold", 200]);

    press(card("B"), "onArchive");
    toast()!.undo!();
    await settle();
    expect(calls.filter((c) => c === "POST /api/lists/archive")).toHaveLength(1);

    held.get("POST /api/lists/archive")!(200);
    await settle();

    expect(sentBodies.filter((s) => s.key === "POST /api/lists/archive").map((s) => s.body)).toEqual([
      { listId: "B", archived: true },
      { listId: "B", archived: false },
    ]);
    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()).toBeNull();
  });

  it("an archive that fails after Undo was tapped shows the card once and sends no undo", async () => {
    await boot();
    replies.set("POST /api/lists/archive", ["hold"]);
    replies.set("GET /api/lists", ["hold"]);

    press(card("B"), "onArchive");
    toast()!.undo!();
    await settle();
    held.get("POST /api/lists/archive")!(500);
    await settle();

    expect(calls.filter((c) => c === "POST /api/lists/archive")).toHaveLength(1);
    expect(listIds()).toEqual(["A", "B", "C"]);
    expect(toast()?.message).toBe("lists.archiveFailed");
  });
```

- [ ] **Step 3: H21 tests**

Insert directly before `describe("Home: edit sheet", () => {`:
```ts
describe("Home: single-list auto-open happens at launch only", () => {
  it("a launch with one list opens it, once", async () => {
    const push = vi.fn();
    H.router.push = push;
    server.lists = ["A"].map(LIST);

    render();
    await settle();
    await (H.onRefreshNeededRef.current as () => Promise<void>)();

    expect(push.mock.calls).toEqual([["/list/A"]]);
  });

  it("deleting down to one list, then a reconnect refresh, stays on Home", async () => {
    const push = vi.fn();
    H.router.push = push;
    server.lists = ["A", "B"].map(LIST);
    render();
    await settle();

    server.lists = ["A"].map(LIST);
    await (H.onRefreshNeededRef.current as () => Promise<void>)();

    expect(push).not.toHaveBeenCalled();
  });

  it("coming back to Home with one list left stays on Home", async () => {
    const push = vi.fn();
    H.router.push = push;
    server.lists = ["A", "B"].map(LIST);
    render();
    await settle();

    // Back from a list: a fresh Home page in the same session, now with one list.
    R.slots = [];
    server.lists = ["A"].map(LIST);
    render();
    await settle();

    expect(push).not.toHaveBeenCalled();
    expect(listIds()).toEqual(["A"]);
  });
});

describe("Home: a reconnect refresh never shows the full-page error", () => {
  const loadError = () =>
    find(render(), (el) => el.type === "p" && el.props.children === "lists.loadError") !== undefined;

  it("a refresh that fails keeps the lists on screen", async () => {
    await boot();
    replies.set("GET /api/lists", ["neterr"]);

    // Whether a failed refresh also rejects (so the orchestrator retries) is T4's contract;
    // this test is about the screen.
    await (H.onRefreshNeededRef.current as () => Promise<void>)().catch(() => {});

    expect(loadError()).toBe(false);
    expect(listIds()).toEqual(["A", "B", "C"]);
  });

  it("the first load that fails shows the Retry screen, and a refresh that works then clears it", async () => {
    replies.set("GET /api/lists", [500]);
    render();
    await settle();
    expect(loadError()).toBe(true);

    await (H.onRefreshNeededRef.current as () => Promise<void>)();

    expect(loadError()).toBe(false);
    expect(listIds()).toEqual(["A", "B", "C"]);
  });
});
```

In `__tests__/unit/home-fetch-lists.test.ts`, the first test calls the registered orchestrator refresh and expects the non-silent Retry screen, which is the old behavior; it now asserts the silent refresh (the Retry screen for a failed first load is covered by the new home-background-saves test, which runs the page's effects). Current:
```ts
  it("logs the status and shows the Retry screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await fetchLists()();
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: false, status: 500 });
    expect(text(render())).toContain("lists.loadError");
  });
```
Replacement:
```ts
  // The orchestrator's refresh is silent: the Retry screen is for the first load (and the
  // Retry button), which home-background-saves.test.ts runs with its effects.
  it("a reconnect refresh logs the status as silent and does not show the Retry screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(500)));
    await fetchLists()();
    expect(console.warn).toHaveBeenCalledWith("[Home] Load lists failed:", { view: "active", silent: true, status: 500 });
    expect(text(render())).not.toContain("lists.loadError");
  });
```

- [ ] **Step 4: Run and see them fail**

Run: `npx vitest run __tests__/unit/home-background-saves.test.ts __tests__/unit/home-fetch-lists.test.ts`

Expected failures: "an Undo tapped while the archive is in flight…" (two archive POSTs before the release), "an archive that fails after Undo was tapped…" (two POSTs), "a delete that fails after Undo was tapped… sends no restore" (`PATCH /api/lists` was sent), "an Undo tapped while the delete is in flight…" (PATCH before the release), "deleting down to one list…" and "coming back to Home with one list left…" (`push("/list/A")`), "a refresh that fails keeps the lists on screen" (`lists.loadError` shown), and the updated home-fetch-lists test (`silent: false`). "the first load that fails shows the Retry screen, and a refresh that works then clears it" and "a launch with one list opens it, once" pass today (today's refresh is non-silent, so it clears the error itself); they guard the new code, and Step 10 shows the first one going red without `setError(false)`.

- [ ] **Step 5: H21, auto-open at launch only, and any successful load clears the error**

In `app/(app)/page.tsx`, inside `fetchLists`, current:
```ts
        setLists(data);
        setLoadedView(requestedView);

        // Auto-open single list — only on first visit to avoid back-navigation
        // loop, and only in the active view. The archived view must not touch
        // the flag either: clearing it there re-arms the redirect, so merely
        // visiting Archived would bounce the user out of Active afterwards.
        if (requestedView === "active") {
          if (data.length === 1) {
            const autoOpened = sessionStorage.getItem("autoOpenedSingleList");
            if (!autoOpened) {
              sessionStorage.setItem("autoOpenedSingleList", "true");
              router.push(`/list/${data[0].id}`);
              return;
            }
          } else {
            // Clear flag when list count changes so auto-open works again
            sessionStorage.removeItem("autoOpenedSingleList");
          }
        }
```
Replacement:
```ts
        setLists(data);
        setLoadedView(requestedView);
        // Any load that worked replaces an error screen, a silent one included.
        setError(false);

        // Auto-open a single list at launch only: the first active-view load of the
        // session decides, and every later one (a refetch, Back from a list, deleting
        // down to one list) leaves the user on Home. The archived view never touches
        // the flag, so visiting Archived first doesn't use up the launch.
        if (requestedView === "active") {
          const autoOpened = sessionStorage.getItem("autoOpenedSingleList");
          sessionStorage.setItem("autoOpenedSingleList", "true");
          if (data.length === 1 && !autoOpened) {
            router.push(`/list/${data[0].id}`);
            return;
          }
        }
```

- [ ] **Step 6: H21, the reconnect refresh is silent**

Current:
```ts
    onRefreshNeededRef.current = fetchLists;
```
Replacement:
```ts
    // Silent: a failed background refresh keeps the lists on screen instead of the
    // full-page error view.
    onRefreshNeededRef.current = () => fetchLists({ silent: true });
```
If T4 already changed this line (for example to pass an option that makes a failed refresh reject so the orchestrator retries), keep T4's options and add `silent: true` to the same object.

- [ ] **Step 7: H16, the archive Undo waits for the archive**

In `handleSetArchived`, current:
```ts
      const timeout = setTimeout(() => setToast(null), 4000);
```
Replacement:
```ts
      const timeout = setTimeout(() => setToast(null), 4000);

      // Settles true once the server archived it, false when that failed (the card is
      // then already put back). The Undo waits for it, so the server never sees the undo
      // before the archive.
      const archiveLanded = post(archived, jwt)
        .then((res) => {
          if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
        })
        .then(
          () => true,
          (e) => {
            console.error("[Home] Archive error:", e);
            clearTimeout(timeout);
            setToast((prev) => {
              if (prev) clearTimeout(prev.timeout);
              return {
                message: t("lists.archiveFailed"),
                timeout: setTimeout(() => setToast(null), 4000),
              };
            });
            if (stillSameView()) {
              setLists(snapshot);
              // silent: a failure must never swap in the full-page error view
              fetchLists({ silent: true });
            }
            return false;
          }
        );
```
Current (inside the toast's `undo`, then the old request at the end of `handleSetArchived`):
```ts
            post(!archived, jwtRef.current)
              .then((res) => throwIfNotOk(res, "Undo archive"))
              .catch((e) => {
                console.error("[Home] Undo archive failed:", { listId: list.id }, e);
                showToast("errors.generic");
                // silent: show the server's state without the full-page error view
                if (stillSameView()) fetchLists({ silent: true });
              });
          },
          timeout,
        };
      });

      post(archived, jwt)
        .then((res) => {
          if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
        })
        .catch((e) => {
          console.error("[Home] Archive error:", e);
          clearTimeout(timeout);
          setToast((prev) => {
            if (prev) clearTimeout(prev.timeout);
            return {
              message: t("lists.archiveFailed"),
              timeout: setTimeout(() => setToast(null), 4000),
            };
          });
          if (!stillSameView()) return;
          setLists(snapshot);
          // silent: a failure must never swap in the full-page error view
          fetchLists({ silent: true });
        });
    },
```
Replacement:
```ts
            void archiveLanded.then((landed) => {
              // The archive itself failed, so the server never archived it: nothing to undo.
              if (!landed) return;
              return post(!archived, jwtRef.current)
                .then((res) => throwIfNotOk(res, "Undo archive"))
                .catch((e) => {
                  console.error("[Home] Undo archive failed:", { listId: list.id }, e);
                  showToast("errors.generic");
                  // silent: show the server's state without the full-page error view
                  if (stillSameView()) fetchLists({ silent: true });
                });
            });
          },
          timeout,
        };
      });
    },
```

- [ ] **Step 8: H16, the delete Undo waits for the delete**

In `handleDeleteList`'s `doDelete`, current:
```ts
      const timeout = setTimeout(() => setToast(null), 4000);

      setToast({
        message: t('lists.deleted'),
        undo: () => {
          clearTimeout(timeout);
          setToast(null);
          // Restore optimistically, back at the position it was removed from
          putBack();
          // Restore on server
          const currentJwt = jwtRef.current;
          fetch("/api/lists", {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${currentJwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id: listToDelete.id, restore: true }),
          })
            .then((res) => throwIfNotOk(res, "Restore"))
            .catch((e) => {
              console.error("[Home] Undo delete failed:", { listId: listToDelete.id }, e);
              showToast("errors.generic");
              // silent: show the server's state without the full-page error view
              if (stillSameView()) fetchLists({ silent: true });
            });
        },
        timeout,
      });

      // Server delete
      fetch(`/api/lists?id=${listToDelete.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      })
        .then((res) => throwIfNotOk(res, "Delete"))
        .catch((e) => {
          console.error("[Home] Delete list failed:", { listId: listToDelete.id }, e);
          clearTimeout(timeout);
          showToast("lists.deleteFailed");
          if (!stillSameView()) return;
          putBack();
          // silent: show the server's state without the full-page error view
          fetchLists({ silent: true });
        });
    };
```
Replacement:
```ts
      const timeout = setTimeout(() => setToast(null), 4000);

      // Server delete. Settles true once the server deleted it, false when that failed
      // (the card is then already back). The Undo waits for it: a restore that arrives
      // first finds nothing to restore, and the delete then lands.
      const deleteLanded = fetch(`/api/lists?id=${listToDelete.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      })
        .then((res) => throwIfNotOk(res, "Delete"))
        .then(
          () => true,
          (e) => {
            console.error("[Home] Delete list failed:", { listId: listToDelete.id }, e);
            clearTimeout(timeout);
            showToast("lists.deleteFailed");
            if (stillSameView()) {
              putBack();
              // silent: show the server's state without the full-page error view
              fetchLists({ silent: true });
            }
            return false;
          }
        );

      setToast({
        message: t('lists.deleted'),
        undo: () => {
          clearTimeout(timeout);
          setToast(null);
          // Restore optimistically, back at the position it was removed from
          putBack();
          void deleteLanded.then((landed) => {
            // The delete itself failed and the card is already back: nothing to restore.
            if (!landed) return;
            // Restore on server
            return fetch("/api/lists", {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${jwtRef.current}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ id: listToDelete.id, restore: true }),
            })
              .then((res) => throwIfNotOk(res, "Restore"))
              .catch((e) => {
                console.error("[Home] Undo delete failed:", { listId: listToDelete.id }, e);
                showToast("errors.generic");
                // silent: show the server's state without the full-page error view
                if (stillSameView()) fetchLists({ silent: true });
              });
          });
        },
        timeout,
      });
    };
```

- [ ] **Step 9: Run green**

Run: `npx vitest run __tests__/unit/home-background-saves.test.ts __tests__/unit/home-fetch-lists.test.ts` → all pass.
Run: `npx vitest run` → all pass (`no-silent-catches.test.ts`: both new rejection handlers log `e` with `console.error`).
Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint "app/(app)/page.tsx" __tests__/unit/home-background-saves.test.ts __tests__/unit/home-fetch-lists.test.ts` → clean.

- [ ] **Step 10: Make it bite**

| remove | red test |
|---|---|
| `archiveLanded.then(...)` → `Promise.resolve(true).then(...)` | "an Undo tapped while the archive is in flight…", "an archive that fails after Undo was tapped…" |
| `if (!landed) return;` in the archive Undo | "an archive that fails after Undo was tapped…" |
| `deleteLanded.then(...)` → `Promise.resolve(true).then(...)` | "an Undo tapped while the delete is in flight…", "a delete that fails after Undo was tapped… sends no restore" |
| `if (!landed) return;` in the delete Undo | "a delete that fails after Undo was tapped… sends no restore" |
| the unconditional `sessionStorage.setItem("autoOpenedSingleList", "true")` (restore the old remove-when-not-one branch) | "deleting down to one list…", "coming back to Home with one list left…" |
| `() => fetchLists({ silent: true })` → `fetchLists` | "a refresh that fails keeps the lists on screen"; home-fetch-lists "a reconnect refresh logs the status as silent…" |
| `setError(false);` in the success branch | "the first load that fails shows the Retry screen, and a refresh that works then clears it" |

- [ ] **Step 11: Commit**

```bash
git add "app/(app)/page.tsx" __tests__/unit/home-background-saves.test.ts __tests__/unit/home-fetch-lists.test.ts
git commit -m "fix(home): undo waits for the original request; auto-open at launch only

The archive and delete Undo are sent only after the original request
landed, and not at all when it failed. A single list auto-opens only on the
session's first Home load. The reconnect refresh is silent, and any load
that works clears the error screen.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 5c: List type, icon and color from realtime; a list that can't be opened

**Files:**
- Modify: `src/hooks/useListRealtime.ts`, `src/hooks/useListData.ts`, `app/(app)/list/[id]/page.tsx`
- Test (modify): `__tests__/unit/list-background-saves.test.ts` (its `realtime` helper passes the new params)
- Test (create): `__tests__/unit/list-realtime-metadata.test.ts`, `__tests__/unit/list-data-unavailable.test.ts`, `__tests__/unit/list-error-view.test.ts`

**Interfaces:**
- Consumes: `useListData`'s existing `setListType`, `setListIcon`, `setListColor`, `listType`, `loadCategories`; strings `errors.notFound`, `lists.loadError`, `common.retry`, `common.goHome` (all exist in en/he/ru; no new keys).
- Produces:
  - `useListRealtime` params gain `setListType: React.Dispatch<React.SetStateAction<ListType>>; setListIcon: React.Dispatch<React.SetStateAction<ListIconName | null>>; setListColor: React.Dispatch<React.SetStateAction<ListColor | null>>; listType: ListType; loadCategories: () => Promise<void>` (types from `@/src/lib/list-icons`).
  - `useListData(...)` also returns `notFound: boolean` (true after the items GET answered 403 or 404; reset at the start of every `fetchItems`).

**Holes:**

| hole | root cause in code (today) | change | test that proves it |
|---|---|---|---|
| H22 (metadata) | `src/hooks/useListRealtime.ts:86-93` a `lists` UPDATE applies only `name` | apply `type` (grocery or regular, as fetchItems reads it), `icon`, `color` when present; load categories when the type becomes grocery | `list-realtime-metadata.test.ts` (7 tests) |
| H22 (unavailable) | `src/hooks/useListData.ts:154-156` a 403/404 sets the same generic `error`; `app/list/[id]/page.tsx:182-195` the error view has only Retry | `notFound` state; the view shows `errors.notFound` + `common.goHome` only for it, and `lists.loadError` + Retry + `common.goHome` otherwise; Go home is `router.replace("/")` | `list-data-unavailable.test.ts` (7), `list-error-view.test.ts` (2) |

The card counts part of H22 is T2's migration (decision 4), not this task.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/list-realtime-metadata.test.ts`:
```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach } from "vitest";

// useListRealtime only needs useCallback here; React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
// Keep the change handler the hook hands to useRealtimeList, so a test can deliver events.
const RT = vi.hoisted(() => ({ onChange: null as ((change: unknown) => void) | null }));
vi.mock("@/src/hooks/useRealtimeList", () => ({
  useRealtimeList: (_c: unknown, _r: unknown, _l: unknown, onChange: (change: unknown) => void) => {
    RT.onChange = onChange;
    return { resubscribe: () => {} };
  },
}));

import { useListRealtime } from "@/src/hooks/useListRealtime";

// The open list page's header state, fed by the real hook.
function page(listType: "regular" | "grocery") {
  const state = { name: "Groceries", type: listType as string, icon: "cart" as string | null, color: "blue" as string | null };
  const apply = <T,>(key: keyof typeof state) => (u: T | ((p: T) => T)) => {
    const prev = state[key] as T;
    (state as Record<string, unknown>)[key] = typeof u === "function" ? (u as (p: T) => T)(prev) : u;
  };
  const loadCategories = vi.fn(async () => {});
  const onListDeleted = vi.fn();
  const params = {
    supabaseClient: null,
    supabaseClientRef: { current: null },
    listId: "L",
    setItems: () => {},
    setListName: apply<string>("name"),
    setListType: apply<string>("type"),
    setListIcon: apply<string | null>("icon"),
    setListColor: apply<string | null>("color"),
    listType,
    loadCategories,
    setCategories: () => {},
    isDraggingRef: { current: false },
    onListDeleted,
  } as unknown as Parameters<typeof useListRealtime>[0];
  useListRealtime(params);
  const listUpdate = (row: Record<string, unknown>) =>
    RT.onChange!({ table: "lists", eventType: "UPDATE", new: { id: "L", deleted_at: null, ...row }, old: { id: "L" } });
  return { state, loadCategories, onListDeleted, listUpdate };
}

beforeEach(() => {
  RT.onChange = null;
});

describe("an open list follows the owner's list settings live", () => {
  it("a switch to grocery changes the type and loads the categories", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "grocery", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("grocery");
    expect(p.loadCategories).toHaveBeenCalledTimes(1);
  });

  it("a switch back to regular changes the type and loads nothing", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Groceries", type: "regular", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("regular");
    expect(p.loadCategories).not.toHaveBeenCalled();
  });

  it("an update of a grocery list that stays grocery does not reload the categories", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Food", type: "grocery", icon: "cart", color: "blue" });

    expect(p.state.name).toBe("Food");
    expect(p.loadCategories).not.toHaveBeenCalled();
  });

  it("a type the app no longer has opens as a regular list", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Groceries", type: "reminders", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("regular");
  });

  it("a new icon and color show at once, and a cleared one clears", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "regular", icon: "home", color: "green" });
    expect(p.state).toMatchObject({ icon: "home", color: "green" });

    p.listUpdate({ name: "Groceries", type: "regular", icon: null, color: null });
    expect(p.state).toMatchObject({ icon: null, color: null });
  });

  it("an update without those columns leaves the header as it is", () => {
    const p = page("regular");

    p.listUpdate({ name: "Renamed" });

    expect(p.state).toEqual({ name: "Renamed", type: "regular", icon: "cart", color: "blue" });
  });

  it("a deleted list still goes home and changes nothing else", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "grocery", icon: "home", deleted_at: "2026-10-29T10:00:00.000Z" });

    expect(p.onListDeleted).toHaveBeenCalledTimes(1);
    expect(p.state).toEqual({ name: "Groceries", type: "regular", icon: "cart", color: "blue" });
    expect(p.loadCategories).not.toHaveBeenCalled();
  });
});
```
(The params object is cast so the test keeps compiling if T4 added required item-merge params; the `lists` branch never reads them.)

Create `__tests__/unit/list-data-unavailable.test.ts`:
```ts
/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListData against a faked network with a slot-based React stand-in
// (state and refs persist across calls, callbacks follow their deps). Nothing renders.
type Slot = { value?: unknown; deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
      return [slot.value, set];
    },
    useRef: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: { current: init } };
      return R.slots[i].value;
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
    useMemo: (fn: () => unknown) => (R.i++, fn()),
    useEffect: () => void R.i++,
  };
});

import { useListData } from "@/src/hooks/useListData";

const jwtRef: { current: string | null } = { current: "jwt" };
const render = () => { R.i = 0; return useListData("L", jwtRef); };

// The list lookups answer normally; the items GET answers `items`.
function stubFetch(items: () => number | "neterr") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url === "/api/lists" || url === "/api/lists?archived=1") return json(200, []);
    if (url.startsWith("/api/lists/L/items")) {
      const reply = items();
      if (reply === "neterr") throw new TypeError("Failed to fetch");
      return reply === 200 ? json(200, { items: [] }) : json(reply, { error: "Access denied" });
    }
    throw new Error(`unexpected ${url}`);
  }));
}

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a list this user can no longer open", () => {
  it.each([403, 404])("an items answer of %i marks the list as not found", async (status) => {
    stubFetch(() => status);
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: true, loading: false });
  });

  it.each([500, 503, 429])("an items answer of %i is an ordinary load error", async (status) => {
    stubFetch(() => status);
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: false });
  });

  it("a load that could not be sent is an ordinary load error", async () => {
    stubFetch(() => "neterr");
    await render().fetchItems();
    expect(render()).toMatchObject({ error: true, notFound: false });
  });

  it("a later load that works clears both", async () => {
    let status = 403;
    stubFetch(() => status);
    await render().fetchItems();
    status = 200;
    await render().fetchItems();
    expect(render()).toMatchObject({ error: false, notFound: false });
  });
});
```
(The React stand-in also covers `useRef`/`useMemo`/`useEffect` in case T4 added one to useListData. If T4 gave `useListData` a required third parameter, pass the same stub `list-data-categories.test.ts` passes after T4.)

Create `__tests__/unit/list-error-view.test.ts` (module mocks as in `list-type-switch.test.ts`; if T3/T4 added a `vi.mock` there for a module the page now imports, copy that line here too):
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real list page component as a plain function with slot-based stand-ins for
// React's hooks (state persists across calls; effects do not run), then presses buttons by
// calling their onClick from the returned element tree. The data hooks are stubbed.
type Slot = { value?: unknown };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = R.slots[i];
    const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
    return [slot.value, set];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: () => void R.i++,
}));

const S = vi.hoisted(() => ({
  data: { error: true, notFound: false },
  fetchItems: (async () => {}) as () => Promise<void>,
  router: { push: (() => {}) as (url: string) => void, replace: (() => {}) as (url: string) => void },
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => S.router, useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    jwt: "jwt",
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwtRef: { current: "jwt" },
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: [], setItems: () => {},
    loading: false, ...S.data, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, setListIcon: () => {}, listColor: null, setListColor: () => {},
    categories: [], setCategories: () => {}, loadCategories: async () => {},
    fetchItems: S.fetchItems, refreshItems: async () => {}, retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: () => ({ addMutation: () => {}, flushQueue: async () => {}, pendingFields: () => new Set() }),
}));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => ({ resubscribe: () => {} }) }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/ItemRow", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// Renders the page down to its first host element: after T1 the default export is the page
// itself (the provider lives in app/(app)/layout.tsx); a wrapper component, if any, is unwrapped.
const render = (): El => {
  R.i = 0;
  let out = (ListPage as unknown as () => El)();
  while (out && typeof out.type === "function") out = (out.type as (p: unknown) => El)(out.props);
  return out;
};

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

const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object" && "props" in node
      ? text((node as El).props.children)
      : typeof node === "string" ? node : "";

// Every button on screen, by its label.
const buttons = () => {
  const out = new Map<string, () => void>();
  for (const b of findAll(render(), (el) => el.type === "button")) out.set(text(b.props.children).trim(), b.props.onClick as () => void);
  return out;
};

let replace: ReturnType<typeof vi.fn>;
let fetchItems: ReturnType<typeof vi.fn>;

beforeEach(() => {
  R.slots = [];
  replace = vi.fn();
  fetchItems = vi.fn(async () => {});
  S.router = { push: vi.fn(), replace };
  S.fetchItems = fetchItems;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the list page when the list can't be opened", () => {
  it("a deleted or unshared list says not found and offers only the way home", () => {
    S.data = { error: true, notFound: true };

    expect(text(render())).toContain("errors.notFound");
    expect(text(render())).not.toContain("lists.loadError");
    expect([...buttons().keys()]).toEqual(["common.goHome"]);

    buttons().get("common.goHome")!();
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("any other load error keeps Retry and also offers the way home", () => {
    S.data = { error: true, notFound: false };

    expect(text(render())).toContain("lists.loadError");
    expect([...buttons().keys()]).toEqual(["common.retry", "common.goHome"]);

    buttons().get("common.retry")!();
    expect(fetchItems).toHaveBeenCalledTimes(1);
    buttons().get("common.goHome")!();
    expect(replace).toHaveBeenCalledWith("/");
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-unavailable.test.ts __tests__/unit/list-error-view.test.ts`

Expected: list-realtime-metadata: 4 of 7 fail ("a switch to grocery…", "a switch back to regular…", "a type the app no longer has…", "a new icon and color…"); the other three already hold today and guard the new code. list-data-unavailable: the two `notFound: true` cases fail (`notFound` is `undefined`), the other five fail too because `toMatchObject` needs `notFound: false`. list-error-view: both fail (no `common.goHome` button, `errors.notFound` absent).

- [ ] **Step 3: useListRealtime applies the list's type, icon and color**

In `src/hooks/useListRealtime.ts`, current:
```ts
import { applyCategoryChange } from "@/src/utils/category-state";
```
Replacement:
```ts
import { applyCategoryChange } from "@/src/utils/category-state";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";
```
In `interface UseListRealtimeParams`, current:
```ts
  setListName: React.Dispatch<React.SetStateAction<string>>;
```
Replacement:
```ts
  setListName: React.Dispatch<React.SetStateAction<string>>;
  setListType: React.Dispatch<React.SetStateAction<ListType>>;
  setListIcon: React.Dispatch<React.SetStateAction<ListIconName | null>>;
  setListColor: React.Dispatch<React.SetStateAction<ListColor | null>>;
  /** The type on screen now, to load categories only when the list becomes a grocery list. */
  listType: ListType;
  loadCategories: () => Promise<void>;
```
In the destructured parameters of `useListRealtime`, current:
```ts
  setListName,
  setCategories,
```
Replacement:
```ts
  setListName,
  setListType,
  setListIcon,
  setListColor,
  listType,
  loadCategories,
  setCategories,
```
Current (the `lists` branch at the end of `onChange`, and its deps; T4 may have added deps for the items branches: keep them and add the five new ones):
```ts
      } else if (change.table === "lists") {
        if (change.eventType === "UPDATE") {
          if (newRec.deleted_at) {
            onListDeleted();
          } else if (newRec.name) {
            setListName(newRec.name as string);
          }
        }
      }
    },
    [setItems, setListName, setCategories, isDraggingRef, onListDeleted]
  );
```
Replacement:
```ts
      } else if (change.table === "lists") {
        if (change.eventType === "UPDATE") {
          if (newRec.deleted_at) {
            onListDeleted();
            return;
          }
          // The owner may have renamed the list or changed its type, icon or color, here
          // or on another device.
          if (newRec.name) setListName(newRec.name as string);
          if (typeof newRec.type === "string") {
            // Same reading as fetchItems: anything but grocery opens as a regular list.
            const nextType: ListType = newRec.type === "grocery" ? "grocery" : "regular";
            setListType(nextType);
            // Nothing loaded categories while the list was another type.
            if (nextType === "grocery" && listType !== "grocery") void loadCategories();
          }
          if ("icon" in newRec) setListIcon((newRec.icon ?? null) as ListIconName | null);
          if ("color" in newRec) setListColor((newRec.color ?? null) as ListColor | null);
        }
      }
    },
    [setItems, setListName, setListType, setListIcon, setListColor, listType, loadCategories, setCategories, isDraggingRef, onListDeleted]
  );
```
`loadCategories` never rejects (it logs its own failures), so `void` is safe and `no-silent-catches` has nothing to flag.

- [ ] **Step 4: useListData marks a list that is gone**

In `src/hooks/useListData.ts`, current:
```ts
  const [error, setError] = useState(false);
```
Replacement:
```ts
  const [error, setError] = useState(false);
  // The list is gone for this user (deleted, or access removed): a 403/404 that Retry can't fix.
  const [notFound, setNotFound] = useState(false);
```
In `fetchItems`, current:
```ts
    try {
      setError(false);
      // Fetch list info
```
Replacement:
```ts
    try {
      setError(false);
      setNotFound(false);
      // Fetch list info
```
In `fetchItems`, the items GET's non-ok branch, current:
```ts
        console.warn("[List] Load items failed:", { listId, status: res.status });
        setError(true);
```
Replacement:
```ts
        console.warn("[List] Load items failed:", { listId, status: res.status });
        setNotFound(res.status === 403 || res.status === 404);
        setError(true);
```
In the hook's `return { … }`, add `notFound` right after `error` (current `loading, error, isShared,` → `loading, error, notFound, isShared,`).

- [ ] **Step 5: The list page wires it up and shows the right error view**

In `app/(app)/list/[id]/page.tsx`:

In the destructuring of `useListData(...)`, add `notFound` after `error`, `setListIcon` after `listIcon`, and `setListColor` after `listColor` (today: `loading, error, isShared, listType, setListType, listIcon, listColor, categories,` → `loading, error, notFound, isShared, listType, setListType, listIcon, setListIcon, listColor, setListColor, categories,`).

Current:
```ts
  const onListDeleted = useCallback(() => router.push("/"), [router]);
```
Replacement:
```ts
  const onListDeleted = useCallback(() => router.push("/"), [router]);
  // From the error view. replace: Back must not lead to a list that can't load.
  const goHome = useCallback(() => router.replace("/"), [router]);
```
In the `useListRealtime({ … })` call, current:
```ts
    setListName,
    setCategories,
```
Replacement (keep any params T4 added to this call):
```ts
    setListName,
    setListType,
    setListIcon,
    setListColor,
    listType,
    loadCategories,
    setCategories,
```
Replace the `if (error) { … }` early return (the one rendering `lists.loadError` and Retry) with the block below. T1 put `<OfflineIndicator />` (and possibly its own no-JWT handling) into this state: keep T1's `<OfflineIndicator />` as the first child of the outer `<div>` and keep T1's Retry `onClick` if it changed it from `fetchItems`. The classes mirror today's Retry button and the invite page's secondary Go home button; no new visual pattern.
```tsx
  if (error) {
    // A deleted or unshared list (403/404): Retry can never work, so only the way home.
    // Any other failure keeps Retry and also offers the way home (a deep link has no Back).
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4">
        <p className="text-tg-hint mb-4">{t(notFound ? 'errors.notFound' : 'lists.loadError')}</p>
        <div className="flex flex-col items-center gap-3">
          {!notFound && (
            <button
              onClick={fetchItems}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
            >
              <RefreshCw className="w-4 h-4" />
              {t('common.retry')}
            </button>
          )}
          <button
            onClick={goHome}
            className={`px-6 py-3 rounded-xl font-medium ${notFound ? "bg-tg-button text-tg-button-text" : "bg-tg-secondary-bg text-tg-text"}`}
          >
            {t('common.goHome')}
          </button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 6: Update the list-page harness's realtime helper**

In `__tests__/unit/list-background-saves.test.ts`, the `realtime` helper's `useListRealtime({...})` call, current:
```ts
      setListName: () => {},
      setCategories: () => {},
```
Replacement:
```ts
      setListName: () => {},
      setListType: () => {},
      setListIcon: () => {},
      setListColor: () => {},
      listType: "regular",
      loadCategories: async () => {},
      setCategories: () => {},
```

- [ ] **Step 7: Run green**

Run: `npx vitest run __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-unavailable.test.ts __tests__/unit/list-error-view.test.ts __tests__/unit/list-background-saves.test.ts __tests__/unit/category-realtime-wiring.test.ts __tests__/unit/list-type-switch.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/list-data-categories.test.ts` → all pass.
Run: `npx vitest run` → all pass.
Run: `npx tsc --noEmit` → no errors.
Run: `npx eslint src/hooks/useListRealtime.ts src/hooks/useListData.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/list-background-saves.test.ts __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-unavailable.test.ts __tests__/unit/list-error-view.test.ts` → clean.

- [ ] **Step 8: Make it bite**

| remove | red test |
|---|---|
| `setListType(nextType);` | "a switch to grocery…", "a switch back to regular…", "a type the app no longer has…" |
| `if (nextType === "grocery" && listType !== "grocery") void loadCategories();` | "a switch to grocery changes the type and loads the categories" |
| `&& listType !== "grocery"` | "an update of a grocery list that stays grocery does not reload the categories" |
| the `=== "grocery" ? "grocery" : "regular"` normalization (use `newRec.type as ListType`) | "a type the app no longer has opens as a regular list" |
| the `setListIcon(...)` line / the `setListColor(...)` line | "a new icon and color show at once, and a cleared one clears" |
| `"icon" in newRec` guard (call `setListIcon` always) | "an update without those columns leaves the header as it is" |
| `return;` after `onListDeleted()` | "a deleted list still goes home and changes nothing else" |
| `setNotFound(res.status === 403 \|\| res.status === 404);` | "an items answer of 403/404 marks the list as not found" |
| `setNotFound(false);` at the start of fetchItems | "a later load that works clears both" |
| `{!notFound && (` (render Retry always) | "a deleted or unshared list says not found and offers only the way home" |
| `t(notFound ? 'errors.notFound' : 'lists.loadError')` → `t('lists.loadError')` | same test |
| `router.replace("/")` → `router.push("/")` | both list-error-view tests |

- [ ] **Step 9: Commit**

```bash
git add src/hooks/useListRealtime.ts src/hooks/useListData.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/list-background-saves.test.ts __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-unavailable.test.ts __tests__/unit/list-error-view.test.ts
git commit -m "fix(list): follow type, icon and color live; a gone list offers the way home

A lists UPDATE now applies the type (loading categories when it becomes a
grocery list), icon and color, not only the name. A 403/404 shows Not found
with only Go home; other load errors keep Retry and also get Go home.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```
