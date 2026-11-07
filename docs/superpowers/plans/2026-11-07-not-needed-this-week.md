# "Not needed this week" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a household take a recurring grocery staple off the list until the week ends, without ticking it, deleting it or stopping the repeat.

**Architecture:** A paused item is parked like a ticked recurring staple (`completed = true`) and carries
`items.paused_until`, the moment its week ends. One function, `respawnAt`, decides when any parked
staple comes back. Every way out of the pause clears `paused_until` on the server, in the optimistic row,
and in the sync engine's field-ownership map.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Supabase Postgres, Tailwind 4, next-intl, date-fns 4,
lucide-react 0.470, vitest (node environment, `__tests__/**/*.test.ts` only).

**Spec:** `docs/superpowers/specs/2026-11-07-not-needed-this-week-design.md`

## Global Constraints

- **Never run `npm run build`:** it migrates the production database. The gate is `npx vitest run`,
  `npx eslint .`, and `npx next typegen && npx tsc --noEmit && npx next build`.
- **Never read, print or commit `.env*` files.** Tests never reach a live service: mock the DB, fetch and
  Telegram.
- **No silent failures.** Every `catch` logs the error (guarded by `__tests__/unit/no-silent-catches.test.ts`).
  Never log item text, list names or tokens.
- **No inline user-facing strings.** Copy lives in `messages/en.json`, `messages/he.json` and
  `messages/ru.json`, and all three get the same keys (`__tests__/unit/locale-parity.test.ts`).
- **Copy, verbatim:** key `items.recurring.notThisWeek`. en `Not needed this week`, he `לא צריך השבוע`,
  ru `На этой неделе не нужно`.
- **The week ends** at next Sunday 00:00, device-local time: `WEEK_STARTS_ON = 0`, via date-fns
  `startOfWeek(addWeeks(now, 1), { weekStartsOn: 0 })`.
- **Server bound on a pause end:** `[tap, tap + 7 days + 1 hour]`. An unparseable value falls back to
  `tap + 7 days`. Never answer a 400 for it.
- **Every change type the client queues** needs a `case` in `src/utils/executor-factory.ts`
  (`single-executor.test.ts`), a `SAMPLES` entry in `mutation-request-parity.test.ts`, and an
  entry in `REPLAYABLE_TYPES` in `executor-factory.test.ts`.
- **Every optimistic row** that leaves or enters the pause sets `paused_until` explicitly, `null` included.
  `overlayPending` only keeps a pending field the on-screen row carries.
- **Git:** implementers only run `git add` and `git commit`, on `main`. Never push and never rewrite
  history. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
  ```
- **Match the surrounding code's comment density and naming.** Comments say why, in plain English.

## Review Focus

1. **The app stays open past Saturday midnight.** The paused row should say "Returning soon", not
   "Not needed this week", and the item comes back on the next list load. This is pinned in Task 4's
   section test.
2. **Typing "milk" while milk is paused** should bring the paused row back with no pause, both on screen
   and on the server. This is pinned in Task 2 (recycler) and Task 3 (`list-merge-flows`, typed add).
3. **Pausing an item whose create is still in flight** (a temp id): the pause waits behind the create and
   lands on the real row. This is pinned in Task 3 (`list-merge-flows`, temp id).
4. **A device clock that is far off, or the week the clocks change:** the pause never lasts more than a
   week and an hour, and the DST weeks compute right. This is pinned in Task 1 (`weekEnd` in
   Asia/Jerusalem) and Task 2 (the clamp).
5. **Pausing an item marked On the way:** the truck mark goes, on screen and on the server, so it can't
   come back marked. This is pinned in Task 2 (the PATCH clears `ordered_at`) and Task 3 (the optimistic
   row).

---

### Task 1: When a parked staple comes back

**Files:**
- Modify: `src/utils/recurring-respawn.ts` (whole file, 34 lines)
- Modify: `src/types/items.ts:5-22` (`ItemData`)
- Modify: `src/hooks/useListDerivedData.ts:48-58` (Recurring sort)
- Test: `__tests__/unit/recurring-respawn.test.ts`, `__tests__/unit/item-sections.test.ts`

**Interfaces:**
- Produces:
  - `WEEK_STARTS_ON: 0`
  - `respawnAt(item: RespawnCandidate): number | null`. Milliseconds, or null for never.
  - `weekEnd(now: Date): Date`
  - `RespawnCandidate.paused_until?: string | null`
  - `ItemData.paused_until?: string | null`
  - `shouldRespawn(item, now)` keeps its signature.
  - `respawnAnchor` keeps its meaning (`completed_at`, or null).

- [ ] **Step 1: Write the failing tests.** Append to `__tests__/unit/recurring-respawn.test.ts`, and add
  `respawnAt, weekEnd` to its import from `@/src/utils/recurring-respawn`. Also add
  `beforeAll, afterAll` to the vitest import.

```ts
describe("a paused staple (Not needed this week)", () => {
  const paused = (until: number, completedAt = FIVE_HOURS_AGO) => ({
    recurring: true,
    completed_at: completedAt,
    paused_until: new Date(until).toISOString(),
  });

  it("stays parked until its week ends, even more than four hours after it was paused", () => {
    expect(shouldRespawn(paused(NOW + 60_000), NOW)).toBe(false);
  });

  it("comes back once its week has ended", () => {
    expect(shouldRespawn(paused(NOW - 60_000), NOW)).toBe(true);
  });

  it("is not back at the exact end of the week (pins > over >=, like the four-hour rule)", () => {
    expect(shouldRespawn(paused(NOW), NOW)).toBe(false);
  });

  it("comes back at the week's end even when that is sooner than four hours (paused on Saturday evening)", () => {
    expect(shouldRespawn(paused(NOW - 1000, ONE_HOUR_AGO), NOW)).toBe(true);
  });

  it("never comes back once deleted — deleting is final", () => {
    expect(shouldRespawn({ ...paused(NOW - 60_000), deleted_at: ONE_HOUR_AGO }, NOW)).toBe(false);
  });

  it("never comes back for a row that no longer repeats", () => {
    expect(shouldRespawn({ ...paused(NOW - 60_000), recurring: false }, NOW)).toBe(false);
  });
});

describe("respawnAt", () => {
  it("is the end of the pause for a paused staple", () => {
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO, paused_until: "2026-09-13T21:00:00.000Z" }))
      .toBe(Date.parse("2026-09-13T21:00:00.000Z"));
  });

  it("is four hours after the tick for a bought staple", () => {
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO })).toBe(Date.parse(ONE_HOUR_AGO) + RESPAWN_AFTER_MS);
  });

  it("is null for an item that never comes back on its own", () => {
    expect(respawnAt({ recurring: false, completed_at: ONE_HOUR_AGO })).toBe(null);
    expect(respawnAt({ recurring: true, completed_at: null })).toBe(null);
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO, paused_until: "2026-09-13T21:00:00.000Z", deleted_at: ONE_HOUR_AGO })).toBe(null);
  });
});

// The week ends at Sunday 00:00 on the phone's clock (an Israeli week). Run in Israel time so the
// two DST weeks are real: clocks go forward on Fri 27 Mar 2026 and back on Sun 25 Oct 2026.
describe("weekEnd (Israel time)", () => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "Asia/Jerusalem";
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it.each([
    ["Sunday morning", "2026-11-08T08:00:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["Thursday evening", "2026-11-12T17:00:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["Saturday 23:30", "2026-11-14T21:30:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["exactly Sunday 00:00 (the next week's end)", "2026-11-14T22:00:00.000Z", "2026-11-21T22:00:00.000Z"],
    ["the week the clocks go forward", "2026-03-25T10:00:00.000Z", "2026-03-28T21:00:00.000Z"],
    ["the week the clocks go back", "2026-10-24T21:00:00.000Z", "2026-10-31T22:00:00.000Z"],
  ])("%s", (_label, now, end) => {
    expect(weekEnd(new Date(now)).toISOString()).toBe(end);
  });

  it("is never more than a week and an hour away (the server's bound)", () => {
    const now = Date.parse("2026-10-24T21:00:00.000Z");
    expect(weekEnd(new Date(now)).getTime() - now).toBe(7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  });
});
```

Append to `__tests__/unit/item-sections.test.ts`, inside `describe("isParkedRecurringItem")`:

```ts
  it("parks a paused staple (Not needed this week), off the active list and out of Not available", () => {
    const i = makeItem({
      recurring: true,
      completed: true,
      completed_at: "2026-11-07T08:00:00Z",
      paused_until: "2026-11-07T22:00:00Z",
    });
    expect(isParkedRecurringItem(i)).toBe(true);
    expect(isActiveItem(i)).toBe(false);
    expect(isSkippedItem(i)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail.**
  Run `npx vitest run __tests__/unit/recurring-respawn.test.ts __tests__/unit/item-sections.test.ts`.
  Expected: FAIL, with `respawnAt`/`weekEnd` not exported and `paused_until` not on `ItemData`
  (a type error shows only under tsc; the runtime failures are enough).

- [ ] **Step 3: Implement.** Replace `src/utils/recurring-respawn.ts` with:

```ts
import { addWeeks, startOfWeek } from "date-fns";

/**
 * When a recurring grocery staple comes back.
 *
 * Recurring items return to the active list 4 hours after being COMPLETED, or, when the household
 * marked them "Not needed this week", when that week ends (`paused_until`).
 * Deleting is final: a soft-deleted item never respawns, whatever else is set
 * on it. Before this rule existed the anchor fell through to `deleted_at`,
 * which made a deleted recurring item impossible to remove — it returned every
 * 4 hours forever, and the 7-day purge cron could never reach it because each
 * respawn cleared `deleted_at`.
 */

export const RESPAWN_AFTER_MS = 4 * 60 * 60 * 1000;

// "Not needed this week" lasts until the week ends: an Israeli week, Sunday to Saturday.
export const WEEK_STARTS_ON = 0;

export interface RespawnCandidate {
  recurring?: boolean;
  completed_at?: string | null;
  deleted_at?: string | null;
  paused_until?: string | null;
}

/**
 * The timestamp the respawn countdown runs from, or null if this item should
 * never come back on its own.
 */
export function respawnAnchor(item: RespawnCandidate): string | null {
  if (!item.recurring) return null;
  if (item.deleted_at) return null;
  return item.completed_at ?? null;
}

/**
 * When a parked staple comes back (ms since epoch), or null if it never comes back on its own:
 * the end of its "Not needed this week" pause, else 4 hours after it was ticked.
 */
export function respawnAt(item: RespawnCandidate): number | null {
  const anchor = respawnAnchor(item);
  if (anchor === null) return null;
  if (item.paused_until) return Date.parse(item.paused_until);
  return Date.parse(anchor) + RESPAWN_AFTER_MS;
}

export function shouldRespawn(item: RespawnCandidate, now: number): boolean {
  const at = respawnAt(item);
  return at !== null && now > at;
}

/** When the week containing `now` ends: the next Sunday 00:00 on this device's clock. Always after `now`. */
export function weekEnd(now: Date): Date {
  return startOfWeek(addWeeks(now, 1), { weekStartsOn: WEEK_STARTS_ON });
}
```

In `src/types/items.ts`, add after `ordered_at: string | null;`:

```ts
  /** "Not needed this week": when this parked recurring staple comes back. Null when not paused. */
  paused_until?: string | null;
```

In `src/hooks/useListDerivedData.ts`:
- Change the import to `import { respawnAt } from "@/src/utils/recurring-respawn";`.
- Replace the `recurringItems` sort so the soonest return comes first. A bought staple (4 hours) sorts
  before one paused for the week.

```ts
  const recurringItems = useMemo(
    () =>
      items
        .filter(isParkedRecurringItem)
        .sort((a, b) => (respawnAt(a) ?? 0) - (respawnAt(b) ?? 0)),
    [items]
  );
```

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run `npx vitest run __tests__/unit/recurring-respawn.test.ts __tests__/unit/item-sections.test.ts __tests__/unit/grouped-list-wiring.test.ts`.
  Expected: PASS. Then run `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
git add src/utils/recurring-respawn.ts src/types/items.ts src/hooks/useListDerivedData.ts __tests__/unit/recurring-respawn.test.ts __tests__/unit/item-sections.test.ts
git commit -m "feat(recurring): a paused staple comes back when its week ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 2: The server stores and ends a pause

**Files:**
- Create: `supabase/migrations/031_item_paused_until.sql`
- Modify: `src/schemas/items.ts:22-38` (`updateItemSchema`)
- Modify: `app/api/lists/[id]/items/route.ts`:
  - line 62: GET select
  - lines 16-29: next to `tapTime`, add `pauseEnd`
  - lines 409-412: the `completed` branch
  - lines 436-450: `recurring` and `restoreRecurring`
  - lines 466-478: the query filters
- Modify: `src/services/item-recycler.ts:118-126` (recycle update)
- Modify: `__tests__/helpers/fake-items-table.ts` (`ItemRow`, `itemRow`)
- Test (create): `__tests__/unit/items-patch-pause.test.ts`, `__tests__/unit/item-recycler-pause.test.ts`
- Test (modify): `__tests__/unit/items-get-columns.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - The PATCH body field `pausedUntil?: string`. Its presence means "pause". `at` is the tap time,
    as for the other actions.
  - Response: 200 with the row; 404 if the row is gone, deleted or no longer recurring.
  - The column `items.paused_until` is returned by GET.

- [ ] **Step 1: Extend the fake table.** In `__tests__/helpers/fake-items-table.ts`, add
  `paused_until: string | null;` to `ItemRow` after `ordered_at`, and `paused_until: null,` to
  `itemRow()`'s defaults after `ordered_at: null,`.

- [ ] **Step 2: Write the failing tests.** Create `__tests__/unit/items-patch-pause.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items PATCH over an in-memory items table; auth, the rate limiter and the
// categorizer are faked. "Not needed this week" parks a recurring staple until the week the
// tapper's phone is in ends; every way out of that state ends the pause.
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
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK_END = iso(Date.parse("2026-11-14T22:00:00.000Z"));
const params = { params: Promise.resolve({ id: "L" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: ITEM, ...body }),
    }),
    params
  );
const row = () => h.db.rows[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk", recurring: true, ordered_at: iso(NOW - DAY) })]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PATCH pausedUntil (Not needed this week)", () => {
  it("parks the staple until its week ends and takes it off On the way", async () => {
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW - 5 * MIN) });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      completed: true,
      completed_at: iso(NOW - 5 * MIN),
      paused_until: WEEK_END,
      skipped_at: null,
      ordered_at: null,
    });
  });

  it("also takes it out of Not available", async () => {
    h.db.rows[0].ordered_at = null;
    h.db.rows[0].skipped_at = iso(NOW - HOUR);
    await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(row().skipped_at).toBe(null);
  });

  it("moves a pause end before the tap up to the tap", async () => {
    await patch({ pausedUntil: iso(NOW - 2 * HOUR), at: iso(NOW - MIN) });
    expect(row().paused_until).toBe(iso(NOW - MIN));
  });

  it("caps a pause end more than a week and an hour away (a wrong device clock)", async () => {
    await patch({ pausedUntil: iso(NOW + 30 * DAY), at: iso(NOW) });
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY + HOUR));
  });

  it("keeps a pause end exactly a week and an hour away (the week the clocks go back)", async () => {
    await patch({ pausedUntil: iso(NOW + 7 * DAY + HOUR), at: iso(NOW) });
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY + HOUR));
  });

  it("pauses for a week after the tap when the end does not parse, never a 400", async () => {
    const res = await patch({ pausedUntil: "next sunday", at: iso(NOW) });
    expect(res.status).toBe(200);
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY));
    expect(console.warn).toHaveBeenCalled();
  });

  it("writes nothing to an item that no longer repeats (a collaborator stopped it first)", async () => {
    h.db.rows[0].recurring = false;
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(res.status).toBe(404);
    expect(row()).toMatchObject({ completed: false, completed_at: null, paused_until: null });
  });

  it("never pauses a deleted item", async () => {
    h.db.rows[0].deleted_at = iso(NOW - HOUR);
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(res.status).toBe(404);
    expect(row().paused_until).toBe(null);
  });
});

describe("every way out of a pause ends it", () => {
  beforeEach(() => {
    Object.assign(h.db.rows[0], { completed: true, completed_at: iso(NOW - DAY), paused_until: WEEK_END, ordered_at: null });
  });

  it.each([
    ["untick", { completed: false }],
    ["tick (a plain buy parks it for the usual four hours)", { completed: true }],
    ["bring it back now", { restoreRecurring: true }],
    ["stop repeating", { recurring: false }],
  ])("%s", async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(row().paused_until).toBe(null);
  });

  it("turning repeat on again leaves the pause alone", async () => {
    await patch({ recurring: true });
    expect(row().paused_until).toBe(WEEK_END);
  });
});
```

Create `__tests__/unit/item-recycler-pause.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Adding a paused staple again (typed, a suggestion tap or voice) recycles it: it comes back to
// the list with no pause left on the row.
const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown; rows: ItemRow[] } }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { recycleItem } from "@/src/services/item-recycler";

const ITEM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({
      id: ITEM, text: "milk", recurring: true, completed: true,
      completed_at: "2026-11-12T08:00:00.000Z", paused_until: "2026-11-14T22:00:00.000Z",
    }),
  ]);
});

describe("recycleItem on a paused staple", () => {
  it("brings it back to the list and ends the pause", async () => {
    const out = await recycleItem(ITEM, "u1", "L", "milk");
    expect(out).not.toBeNull();
    expect(h.db.rows[0]).toMatchObject({ completed: false, completed_at: null, paused_until: null });
  });
});
```

In `__tests__/unit/items-get-columns.test.ts`, add a second test inside the `describe`:

```ts
  it("returns each item's pause end, so a paused staple stays parked until its week ends", async () => {
    h.fake = fakeSupabase(() => ({ data: [], error: null }));
    await GET(new NextRequest("https://app.test/api/lists/l1/items?limit=500"), { params: Promise.resolve({ id: "l1" }) });

    const select = h.fake.calls.find((c) => c.table === "items" && c.op === "select")!;
    expect(select.cols).toMatch(/\bpaused_until\b/);
  });
```

- [ ] **Step 3: Run the tests and confirm they fail.**
  Run `npx vitest run __tests__/unit/items-patch-pause.test.ts __tests__/unit/item-recycler-pause.test.ts __tests__/unit/items-get-columns.test.ts`.
  Expected: FAIL. The PATCH answers 400 "No valid fields to update", the recycler leaves `paused_until`
  set, and the select has no `paused_until`.

- [ ] **Step 4: Implement.**

`supabase/migrations/031_item_paused_until.sql`:

```sql
-- "Not needed this week" (docs/superpowers/specs/2026-11-07-not-needed-this-week-design.md): when a
-- recurring grocery staple the household skipped for the week comes back. Null when not paused.
-- No index: nothing on the server filters on it; the client compares it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
```

`src/schemas/items.ts`:
- In `updateItemSchema`, add after `categoryId`:

```ts
  // "Not needed this week": when the pause ends, as the tapper's phone computed it (the end of
  // its week). Unbounded text here; the route clamps it and never answers 400 for it.
  pausedUntil: z.string().max(64).optional(),
```

- Change the `at` comment's first line to
  `// When the user tapped (ISO date-time), for completed_at / skipped_at / ordered_at and a pause. Optional:`.

`app/api/lists/[id]/items/route.ts`:
- After `tapTime`, add:

```ts
// "Not needed this week" lasts until the tapper's week ends: at most 7 days, plus the hour a DST
// change adds to a local week.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PAUSE_MAX_MS = WEEK_MS + 60 * 60 * 1000;

// When a pause ends. The phone computes its own week end (the server has no time zone); clamped to
// [tap, tap + a week and an hour] so a wrong device clock can't hide a staple for longer. A value
// that does not parse falls back to a week after the tap, never a 400, because the queue would
// drop the user's change on a 4xx.
function pauseEnd(raw: string, stamp: string, context: { listId: string; itemId: string }): string {
  const tap = Date.parse(stamp);
  const end = Date.parse(raw);
  if (Number.isNaN(end)) {
    console.warn("[items/PATCH] Pause end does not parse, pausing for a week:", context);
    return new Date(tap + WEEK_MS).toISOString();
  }
  return new Date(Math.min(tap + PAUSE_MAX_MS, Math.max(tap, end))).toISOString();
}
```

- In the GET select (line 62), change `ordered_at, recurring,` to `ordered_at, recurring, paused_until,`.
- In the `completed` branch:

```ts
  if (typeof updates.completed === "boolean") {
    patchData.completed = updates.completed;
    patchData.completed_at = updates.completed ? stamp : null;
    // A tick or an untick ends a "Not needed this week" pause: a plain buy parks a staple for the
    // usual 4 hours.
    patchData.paused_until = null;
  }
```

- In the `recurring` branch:

```ts
  if (typeof updates.recurring === "boolean") {
    patchData.recurring = updates.recurring;
    // A pause only means something on a recurring item.
    if (!updates.recurring) patchData.paused_until = null;
  }
```

- In the `restoreRecurring` branch, add `patchData.paused_until = null;` after `patchData.ordered_at = null;`.
- Directly after the `restoreRecurring` block (and before the `deleted_at === null` block), add:

```ts
  // "Not needed this week": park the recurring staple like a tick, until its week ends. It leaves
  // the active list, so On the way / Not available go with it. Last of the branches that write
  // `completed`, so a pause wins over its own completed = true.
  if (typeof updates.pausedUntil === "string") {
    patchData.completed = true;
    patchData.completed_at = stamp;
    patchData.paused_until = pauseEnd(updates.pausedUntil, stamp, { listId, itemId });
    patchData.skipped_at = null;
    patchData.ordered_at = null;
  }
```

- After `if (patchData.deleted_at !== null) { query = query.is("deleted_at", null); }`, add:

```ts
  // A pause that lands after a collaborator stopped the repeat writes nothing (404 below).
  if (typeof updates.pausedUntil === "string") {
    query = query.eq("recurring", true);
  }
```

`src/services/item-recycler.ts`:
- In the recycle `update({...})`, add `paused_until: null,` after `ordered_at: null,`.
- Change the doc line `- Completed: sets completed=false, clears completed_at, skipped_at and ordered_at,` to
  `- Completed: sets completed=false, clears completed_at, skipped_at, ordered_at and paused_until,`.

- [ ] **Step 5: Run the tests and confirm they pass.**
  Run `npx vitest run __tests__/unit/items-patch-pause.test.ts __tests__/unit/item-recycler-pause.test.ts __tests__/unit/items-get-columns.test.ts __tests__/unit/items-patch-tap-time.test.ts __tests__/unit/items-patch-db-errors.test.ts __tests__/unit/item-recycler.test.ts __tests__/unit/recycle-replay.test.ts`.
  Expected: PASS. Then run `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/031_item_paused_until.sql src/schemas/items.ts "app/api/lists/[id]/items/route.ts" src/services/item-recycler.ts __tests__/helpers/fake-items-table.ts __tests__/unit/items-patch-pause.test.ts __tests__/unit/item-recycler-pause.test.ts __tests__/unit/items-get-columns.test.ts
git commit -m "feat(items): the server pauses a recurring staple until its week ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 3: The pause through the sync engine

**Files:**
- Modify: `src/utils/executor-factory.ts`. Header comment at lines 3-5; a new `case "pause"` after `case "order"`.
- Modify: `src/sync/engine.ts:96-109` (`FIELDS`)
- Modify: `src/hooks/useItemHandlers.ts`:
  - `recycleCompleted` at 158-170
  - `handleToggle` at 216-249
  - `handleSetRecurring` at 397-414
  - `handleRestoreRecurring` at 416-437
  - a new `handlePause`
  - the hook's return object
- Modify: `src/hooks/useListData.ts:196` (the respawn optimistic row)
- Test (modify):
  - `__tests__/unit/executor-factory.test.ts`
  - `__tests__/unit/mutation-request-parity.test.ts`
  - `__tests__/unit/sync-engine.test.ts`, plus any existing exact-set assertions that include `toggle`,
    `set-recurring` or `restore-recurring` fields
  - `__tests__/unit/list-merge-flows.test.ts`

**Interfaces:**
- Consumes:
  - `weekEnd(now: Date): Date` from `@/src/utils/recurring-respawn` (Task 1)
  - `ItemData.paused_until` (Task 1)
  - the PATCH body `{ itemId, pausedUntil, at }` (Task 2)
- Produces:
  - `handlePause(itemId: string): void`, returned by `useItemHandlers`
  - the mutation type `"pause"`, payload `{ listId, itemId, pausedUntil: string, at: string }`

- [ ] **Step 1: Write the failing tests.**

`__tests__/unit/executor-factory.test.ts`:
- Add `"pause",` to `REPLAYABLE_TYPES` after `"order",`.
- In the `"createExecutorFactory - tap time"` `it.each`, add the row
  `["pause", { pausedUntil: "2026-11-14T22:00:00.000Z" }],`.
- After that `describe`, add:

```ts
describe("createExecutorFactory - pause", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the item with the pause end and throws with the HTTP status when the server rejects it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const factory = createExecutorFactory();
    const run = factory({ id: "m", type: "pause", payload: { listId: "l1", itemId: "i1", pausedUntil: "2026-11-14T22:00:00.000Z", at: "2026-11-12T15:00:00.000Z" }, timestamp: 0 }, () => "jwt")!;

    await expect(run()).rejects.toThrow(/^Pause failed: 404$/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lists/l1/items");
    expect(init.method).toBe("PATCH");
    expect(init.keepalive).toBe(true);
  });
});
```

`__tests__/unit/mutation-request-parity.test.ts`, in `SAMPLES` after `order`:

```ts
  pause: { itemId: A, pausedUntil: "2026-11-01T22:00:00.000Z", at: AT },
```

`__tests__/unit/sync-engine.test.ts`, inside `describe("pendingFields")`:
- Change the `restore-recurring` expectation to also contain `"paused_until"`.
- Update every other exact `Set` assertion in the file that includes a `toggle`'s fields
  (`"completed", "completed_at"`) to also contain `"paused_until"`. Search the file for
  `"completed_at"` inside `new Set(`. Those tests stay meaningful: they pin the full set.
- Add:

```ts
  it("covers every field a pause, a tick and a stop-repeating change", async () => {
    const w = world();
    w.jwt.current = null;
    w.add("pause", { itemId: "p1", pausedUntil: "2026-11-14T22:00:00.000Z", at: "2026-11-12T15:00:00.000Z" });
    w.add("toggle", { itemId: "p2", completed: false });
    w.add("set-recurring", { itemId: "p3", recurring: false });

    expect(w.engine().pendingFields("p1")).toEqual(
      new Set(["completed", "completed_at", "paused_until", "skipped_at", "ordered_at"])
    );
    expect(w.engine().pendingFields("p2")).toEqual(new Set(["completed", "completed_at", "paused_until"]));
    expect(w.engine().pendingFields("p3")).toEqual(new Set(["recurring", "paused_until"]));
  });
```

`__tests__/unit/list-merge-flows.test.ts`:
- Add a new `describe` at the end, using the same `open()`, `row()`, `hold`, `release`, `refresh`,
  `realtime`, `item`, `items`, `sent` and `settle` helpers as the
  `"a pending restore-recurring or on the way keeps the item where the user put it (R2)"` block.
  Read that block and the harness at the top of the file first, and match its API exactly.
- `row()` builds an `ItemData`. Pass `paused_until` through its overrides.

```ts
describe("Not needed this week (pause)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  const pausedRow = (over: Partial<ItemData> = {}) =>
    row({ id: "a", recurring: true, completed: true, completed_at: later(-DAY), paused_until: later(2 * DAY), position: 1, ...over });

  it("pausing parks the item at once and sends the pause with the week's end", async () => {
    const p = await open([row({ id: "a", recurring: true, ordered_at: later(-DAY) })]);
    p.render().handlePause("a");
    await settle();

    expect(p.item("a")).toMatchObject({ completed: true, ordered_at: null, skipped_at: null });
    expect(Date.parse(p.item("a")!.paused_until!)).toBeGreaterThan(Date.now());
    // The PATCH body carries pausedUntil and at (adapt to how `sent` records bodies in this file).
  });

  it("a refresh while the pause is still being saved keeps the item parked", async () => {
    const p = await open([row({ id: "a", recurring: true })]);
    p.hold("PATCH a");
    p.render().handlePause("a");
    await settle();
    const until = p.item("a")!.paused_until;

    await p.refresh();

    expect(p.item("a")).toMatchObject({ completed: true, paused_until: until });
  });

  it("a refresh while a paused item is being brought back leaves it on the list with no pause", async () => {
    const p = await open([pausedRow()]);
    p.hold("PATCH a");
    p.render().handleRestoreRecurring("a");
    await settle();

    p.server.items = [pausedRow()];
    await p.refresh();

    expect(p.item("a")).toMatchObject({ completed: false, paused_until: null });
  });

  it("an echo of the paused row while an untick is being saved does not bring the pause back", async () => {
    const p = await open([pausedRow()]);
    p.hold("PATCH a");
    await p.render().handleToggle("a", false);
    await settle();

    p.realtime({ eventType: "UPDATE", new: pausedRow() });

    expect(p.item("a")).toMatchObject({ completed: false, paused_until: null });
  });

  it("an echo of the paused row while stop-repeating is being saved does not bring the pause back", async () => {
    const p = await open([pausedRow()]);
    p.hold("PATCH a");
    p.render().handleSetRecurring("a", false);
    await settle();

    p.realtime({ eventType: "UPDATE", new: pausedRow() });

    expect(p.item("a")).toMatchObject({ recurring: false, paused_until: null });
  });

  it("typing the paused item's text again brings it back with no pause", async () => {
    const p = await open([pausedRow({ text: "milk" })]);
    await p.render().handleAddItem("milk");
    await settle();

    expect(p.item("a")).toMatchObject({ completed: false, paused_until: null });
  });

  it("loading the list after the week ended brings a paused item back", async () => {
    const p = await open([pausedRow({ completed_at: later(-3 * DAY), paused_until: later(-60_000) })]);

    expect(p.item("a")).toMatchObject({ completed: false, paused_until: null });
  });

  it("loading the list mid-week keeps a paused item parked, days after it was paused", async () => {
    const p = await open([pausedRow({ completed_at: later(-3 * DAY) })]);

    expect(p.item("a")).toMatchObject({ completed: true });
    expect(p.item("a")!.paused_until).not.toBeNull();
  });

  it("pausing an item whose create is still on its way lands the pause on the saved row", async () => {
    // Follow the pattern of describe("a change made to a new item while its create is on its way
    // shows on the saved row"): add an item, hold its POST, set it recurring and pause it, release
    // the POST, settle, and assert that the saved row is parked with a pause end, and that the PATCH
    // sent for the pause names the real id.
  });
});
```

  The last test's body has to be written against that block's helpers. Mirror the nearest existing
  "change on a new item while its create is on its way" test line by line, swapping its change for
  `handleSetRecurring(tempId, true)` followed by `handlePause(tempId)`. The `PATCH` assertion in the
  first test follows the same rule: assert `pausedUntil` and `at` are in the sent body, using
  however `p.sent` records bodies.

- [ ] **Step 2: Run the tests and confirm they fail.**
  Run `npx vitest run __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/sync-engine.test.ts __tests__/unit/list-merge-flows.test.ts`.
  Expected: FAIL. There is no `pause` case (null executor), `pendingFields` lacks `paused_until`, and
  `handlePause` is not a function.

- [ ] **Step 3: Implement.**

`src/utils/executor-factory.ts`:
- Header comment: change `Tap time for toggle / skip / order:` to `Tap time for toggle / skip / order / pause:`.
- After `case "order"`:

```ts
      case "pause":
        return async () => {
          const jwt = getJwt();
          const res = await fetch(`/api/lists/${payload.listId}/items`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ itemId: payload.itemId, pausedUntil: payload.pausedUntil, at: tapTime(mutation) }),
            keepalive: true,
          });
          if (!res.ok) throw new Error(`Pause failed: ${res.status}`);
        };
```

`src/sync/engine.ts` `FIELDS`:

```ts
const FIELDS: Record<string, string[]> = {
  // A tick or an untick also ends a "Not needed this week" pause.
  toggle: ["completed", "completed_at", "paused_until"],
  edit: ["text"],
  skip: ["skipped_at"],
  // "On the way" also clears a skip.
  order: ["ordered_at", "skipped_at"],
  // "Not needed this week" parks the item like a tick and takes it off On the way / Not available.
  pause: ["completed", "completed_at", "paused_until", "skipped_at", "ordered_at"],
  "set-category": ["category_id", "category_locked"],
  // Stopping the repeat also ends a pause.
  "set-recurring": ["recurring", "paused_until"],
  // Restoring a recurring item also unticks it, clears skip / on the way / a pause and moves it.
  "restore-recurring": ["recurring", "completed", "completed_at", "skipped_at", "ordered_at", "paused_until", "position"],
  delete: ["deleted"],
  restore: ["deleted"],
};
```

`src/hooks/useItemHandlers.ts`:
- Import `weekEnd` from `@/src/utils/recurring-respawn`.
- In `recycleCompleted`'s optimistic object, add `paused_until: null` after `ordered_at: null`.
- In `handleToggle`'s optimistic object, add `paused_until: null,` after `completed_at: completed ? at : null,`.
- In `handleSetRecurring`: `prev.map((i) => (i.id === itemId ? { ...i, recurring, paused_until: recurring ? (i.paused_until ?? null) : null } : i))`.
- In `handleRestoreRecurring`'s optimistic object, add `paused_until: null` after `ordered_at: null`.
- Add after `handleOrder`:

```ts
  // "Not needed this week" on a recurring grocery staple: parked like a tick, it comes back when
  // this phone's week ends rather than 4 hours later. `at` is the tap time the server stamps
  // completed_at with. The row's button gives the haptic, as for a tick.
  const handlePause = useCallback(
    (itemId: string) => {
      const at = new Date().toISOString();
      const pausedUntil = weekEnd(new Date(at)).toISOString();

      const isItem = sameItem(itemId);
      setItems((prev) =>
        prev.map((i) =>
          isItem(i)
            ? { ...i, completed: true, completed_at: at, paused_until: pausedUntil, skipped_at: null, ordered_at: null }
            : i
        )
      );

      addMutation({
        id: genMutId(),
        type: "pause",
        payload: { listId, itemId, pausedUntil, at },
      });
    },
    [listId, addMutation, setItems, sameItem]
  );
```

- Add `handlePause` to the hook's returned object, next to `handleOrder`.

`src/hooks/useListData.ts`:
- In the respawn branch's returned row (line 196), add `paused_until: null` after `ordered_at: null`.
- Change the comment above it from `// Auto-respawn recurring items past the same 4-hour threshold.` to
  `// Auto-respawn recurring items past the same 4-hour threshold, or a paused one whose week has ended.`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run `npx vitest run __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/sync-engine.test.ts __tests__/unit/list-merge-flows.test.ts __tests__/unit/single-executor.test.ts __tests__/unit/restore-skipped-flow.test.ts`.
  Expected: PASS. Then run the whole suite with `npx vitest run`, and `npx tsc --noEmit`.
  Expected: PASS and no errors.

- [ ] **Step 5: Commit.**

```bash
git add src/utils/executor-factory.ts src/sync/engine.ts src/hooks/useItemHandlers.ts src/hooks/useListData.ts __tests__/unit/executor-factory.test.ts __tests__/unit/mutation-request-parity.test.ts __tests__/unit/sync-engine.test.ts __tests__/unit/list-merge-flows.test.ts
git commit -m "feat(sync): Not needed this week is saved like any change, and every way out ends it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 4: The button and the paused row

**Files:**
- Modify: `components/ItemRow.tsx`:
  - the import at line 5
  - the props interface at 8-30
  - the destructure at 32-55
  - the new button after the On the way button, at about line 223
- Modify: `components/SortableItem.tsx` (interface, destructure, `<ItemRow>` call)
- Modify: `app/(app)/list/[id]/page.tsx`:
  - the handler destructure at line 158
  - the grouped map at about 356-360
  - the ungrouped map at about 382-386
- Modify: `components/list/RecurringItemsSection.tsx`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (`items.recurring`)
- Test (create): `__tests__/unit/not-this-week-ui.test.ts`

**Interfaces:**
- Consumes:
  - `handlePause(itemId: string)` from `useItemHandlers` (Task 3)
  - `respawnAt(item)` (Task 1)
  - `ItemData.paused_until` (Task 1)
- Produces: the `ItemRow` prop `onPause?: (id: string) => void`, and the same prop on `SortableItem`.

- [ ] **Step 1: Write the failing tests.** Create `__tests__/unit/not-this-week-ui.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";

// The row button, the paused row in the Recurring drawer, and the page wiring for "Not needed
// this week". Translations echo their key.
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ""}${key}${values ? JSON.stringify(values) : ""}`,
  useLocale: () => "en",
}));
// ItemRow runs as a plain function below, so its hooks need a stand-in outside a render.
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
  };
});

import ItemRow from "@/components/ItemRow";
import RecurringItemsSection from "@/components/list/RecurringItemsSection";

type El = { props: Record<string, unknown> & { children?: unknown } };
function findEl(node: unknown, pred: (el: El) => boolean): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (!el.props) return null;
  if (pred(el)) return el;
  return findEl(el.props.children, pred);
}

const PAUSE_LABEL = "items.recurring.notThisWeek";
const rowProps = (over: Record<string, unknown> = {}) => ({
  id: "a", text: "Milk", completed: false,
  onToggle: () => {}, onDelete: () => {}, onSkip: () => {}, onOrder: () => {}, onToggleRecurring: () => {},
  recurring: true, onPause: () => {},
  ...over,
});
const pauseButton = (props: Record<string, unknown>) =>
  findEl((ItemRow as (p: unknown) => unknown)(props), (el) => el.props["aria-label"] === PAUSE_LABEL);

describe("ItemRow: the Not needed this week button", () => {
  beforeEach(() => vi.stubGlobal("window", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("shows on a recurring row and pauses that item when tapped", () => {
    const onPause = vi.fn();
    const btn = pauseButton(rowProps({ onPause }));
    expect(btn).not.toBeNull();
    (btn!.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onPause).toHaveBeenCalledWith("a");
  });

  it("is not on a row that does not repeat", () => {
    expect(pauseButton(rowProps({ recurring: false }))).toBeNull();
  });

  it("is not on a ticked row", () => {
    expect(pauseButton(rowProps({ completed: true }))).toBeNull();
  });

  it("is not there when the list gives no pause handler (a regular list)", () => {
    expect(pauseButton(rowProps({ onPause: undefined }))).toBeNull();
  });

  it("sits between On the way and Repeat, as the owner chose", () => {
    const html = renderToStaticMarkup(createElement(ItemRow, rowProps() as never));
    const order = ["items.ordered.toggleOn", PAUSE_LABEL, "items.recurring.toggleOff"].map((l) => html.indexOf(`aria-label="${l}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});

describe("RecurringItemsSection: a paused staple", () => {
  const NOW = Date.parse("2026-11-12T15:00:00.000Z");
  const HOUR = 60 * 60 * 1000;
  const item = (id: string, over: Partial<ItemData>): ItemData => ({
    id, text: id, completed: true, completed_at: new Date(NOW - HOUR).toISOString(), deleted_at: null,
    skipped_at: null, ordered_at: null, recurring: true, position: 1,
    created_by: null, creator_name: null, edited_by: null, editor_name: null, ...over,
  });
  const render = (items: ItemData[]) =>
    renderToStaticMarkup(
      createElement(RecurringItemsSection, {
        recurringItems: items, showRecurring: true, setShowRecurring: () => {},
        onRestoreRecurring: () => {}, onToggleRecurring: () => {},
      })
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("says Not needed this week and is not struck through like a bought one", () => {
    const html = render([
      item("Bread", {}),
      item("Milk", { paused_until: new Date(NOW + 2 * 24 * HOUR).toISOString() }),
    ]);
    expect(html).toContain(PAUSE_LABEL);
    expect(html).toContain("items.recurring.returnsInHours");
    expect(html.match(/line-through/g)).toHaveLength(1);
    expect(html).toMatch(/line-through[^>]*>Bread</);
  });

  it("says Returning soon once its week has ended and the list has not reloaded yet", () => {
    const html = render([item("Milk", { paused_until: new Date(NOW - 60_000).toISOString() })]);
    expect(html).toContain("items.recurring.returningSoon");
    expect(html).not.toContain(PAUSE_LABEL);
  });
});

describe("the list page hands the pause to every grocery row", () => {
  const page = readFileSync(resolve(__dirname, "../../app/(app)/list/[id]/page.tsx"), "utf8");
  const sortable = readFileSync(resolve(__dirname, "../../components/SortableItem.tsx"), "utf8");

  it("in the grouped (categorized) list", () => {
    expect(page).toMatch(/onPause=\{handlePause\}/);
  });

  it("in the plain list, for grocery lists only", () => {
    expect(page).toMatch(/onPause=\{listType === "grocery" \? handlePause : undefined\}/);
  });

  it("SortableItem passes it to the row", () => {
    expect(sortable).toMatch(/onPause=\{onPause\}/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
  Run `npx vitest run __tests__/unit/not-this-week-ui.test.ts`.
  Expected: FAIL. There is no button with that label, no caption, and no `onPause` in the page.

- [ ] **Step 3: Implement.**

The `messages/*.json` files: inside `items.recurring`, add after `"returningSoon"`. Add the comma to the
previous line.
- `messages/en.json`: `"notThisWeek": "Not needed this week"`
- `messages/he.json`: `"notThisWeek": "לא צריך השבוע"`
- `messages/ru.json`: `"notThisWeek": "На этой неделе не нужно"`

`components/ItemRow.tsx`:
- Import: add `CalendarOff` to the lucide import, in alphabetical order:
  `import { CalendarOff, Check, CircleOff, Clock, Copy, Pencil, Repeat, RotateCcw, Truck, X } from "lucide-react";`.
- Props interface: after `onToggleRecurring?: ...`, add `onPause?: (id: string) => void;`.
- Destructure: add `onPause,` after `onToggleRecurring,`.
- After the `{onOrder && !completed && (...)}` block and before `{onToggleRecurring && (`, add:

```tsx
      {onPause && recurring && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const tg = getTelegramWebApp();
            tg?.HapticFeedback?.impactOccurred("light");
            onPause(id);
          }}
          className="p-1.5 rounded-full shrink-0 transition-transform duration-150 active:scale-90"
          aria-label={t("recurring.notThisWeek")}
        >
          <CalendarOff className="w-[18px] h-[18px] text-tg-hint" />
        </button>
      )}
```

`components/SortableItem.tsx`:
- Add `onPause?: (id: string) => void;` to the props interface after `onToggleRecurring`.
- Add `onPause,` to the destructure after `onToggleRecurring,`.
- Pass `onPause={onPause}` to `<ItemRow>` after `onToggleRecurring={onToggleRecurring}`.

`app/(app)/list/[id]/page.tsx`:
- Add `handlePause` to the `useItemHandlers` destructure after `handleOrder`.
- In the grouped map, after `onToggleRecurring={handleSetRecurring}`, add `onPause={handlePause}`.
- In the ungrouped map, after `onToggleRecurring={listType === "grocery" ? handleSetRecurring : undefined}`,
  add `onPause={listType === "grocery" ? handlePause : undefined}`.

`components/list/RecurringItemsSection.tsx`:
- Imports: `import { CalendarOff, Check, ChevronDown, ChevronRight, Repeat } from "lucide-react";` and
  `import { respawnAt } from "@/src/utils/recurring-respawn";`. This replaces the
  `respawnAnchor, RESPAWN_AFTER_MS` import.
- Replace `formatReturnsIn`:

```tsx
  // A bought staple counts down its 4 hours; a paused one is away until its week ends. Either
  // says "Returning soon" once its time has passed and the list has not reloaded yet.
  const formatReturnsIn = (item: ItemData): string => {
    const at = respawnAt(item);
    if (at === null) return "";
    const remainingMs = at - now;
    if (remainingMs <= 0) return t("items.recurring.returningSoon");
    if (item.paused_until) return t("items.recurring.notThisWeek");
    const minutes = Math.ceil(remainingMs / 60000);
    if (minutes < 60) return t("items.recurring.returnsInMinutes", { count: minutes });
    const hours = Math.ceil(minutes / 60);
    return t("items.recurring.returnsInHours", { count: hours });
  };
```

- In the row map, drop `const anchor = respawnAnchor(item);` and add `const paused = !!item.paused_until;`.
- The restore button:
  - Its `className` becomes:
    ``className={`w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0 transition-all duration-200 active:scale-90 ${paused ? "border-[1.5px] border-tg-hint/60" : "bg-tg-button border-[1.5px] border-tg-button"}`}``
  - Its child becomes:
    `{paused ? <CalendarOff className="w-3 h-3 text-tg-link" strokeWidth={3} /> : <Check className="w-3.5 h-3.5 text-tg-button-text" />}`
  - A paused staple wasn't bought, so it shows the app's unchecked ring with the pause glyph in the
    on-state recipe (`tg-link` + bold stroke) instead of a filled tick.
- The text: ``<div className={`truncate text-tg-text ${paused ? "" : "line-through"}`}>{item.text}</div>``.
- The caption: `{formatReturnsIn(item)}`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run `npx vitest run __tests__/unit/not-this-week-ui.test.ts __tests__/unit/locale-parity.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/list-sync-wiring.test.ts`.
  Expected: PASS. Then run `npx vitest run`, `npx eslint .` and `npx tsc --noEmit`.
  Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add components/ItemRow.tsx components/SortableItem.tsx "app/(app)/list/[id]/page.tsx" components/list/RecurringItemsSection.tsx messages/en.json messages/he.json messages/ru.json __tests__/unit/not-this-week-ui.test.ts
git commit -m "feat(ui): Not needed this week button on recurring rows; paused staples wait in Recurring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y"
```

---

### Task 5 (controller): docs, gate, ship

- [ ] In `README.md` line 28, change the recurring bullet to: `- **Recurring grocery staples** — mark a grocery item as recurring and it returns to the list four hours after you check it off. Not needed this week? Tap the calendar icon and it stays off the list until the week ends (Saturday night).`
- [ ] Full gate: `npx vitest run`, `npx eslint .`, `npx next typegen && npx tsc --noEmit && npx next build`.
- [ ] Do bite checks on each guard. Remove it, run its test, see it go red, and restore it:
  - each `paused_until = null` clear on the server
  - each new `FIELDS` entry
  - the `.eq("recurring", true)` filter
  - both sides of the clamp
  - each optimistic `paused_until: null`
  - the `ItemRow` visibility conditions
- [ ] Whole-branch review (most capable model). Fix every valid finding.
- [ ] Delete this plan file (shipped plans don't stay), write the project memory, commit, push to main,
  watch the Vercel deploy and ping the owner.
