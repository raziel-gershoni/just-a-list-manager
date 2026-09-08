# Delete Is Final — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A soft-deleted item is never restored automatically; only completion still triggers the 4-hour recurring respawn.

**Architecture:** Extract the respawn decision out of `useListData`'s inline `.map()` into a pure, unit-tested utility that refuses any row carrying `deleted_at`. Then narrow the three consumers that currently assume soft-deleted recurring rows are in scope: the GET query, the Recurring drawer, and the server's `restoreRecurring` branch. No migration, no backfill.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (PostgREST), Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-delete-is-final-design.md`

## Global Constraints

- Vitest `include` is `["__tests__/**/*.test.ts"]` (`vitest.config.ts:11`). **`.tsx` test files are silently skipped** — every test in this plan is `.ts`, testing pure functions or inspecting source text. There is no jsdom; do not try to render React.
- Path alias `@/` resolves to the repo root (`vitest.config.ts:6-8`).
- Run the full suite with `npx vitest run`. A single file: `npx vitest run __tests__/unit/<name>.test.ts`.
- `npx tsc --noEmit` must stay clean. `npx eslint .` must report **exactly** the 6 pre-existing problems (3 errors, 3 warnings, in `app/login/callback/page.tsx`, `components/TimePicker.tsx`, `components/ReminderSheet.tsx`, `src/hooks/useItemHandlers.ts`) — no new ones.
- Migrations are append-only and applied at build time; **this plan adds none**.
- Do not connect to a database. `.env.local` `DATABASE_URL` points at production.
- Do not touch the duplicate-creation half (add-time check, voice fuzzy match, `recycleId` validation). Those are listed as out-of-scope in the spec and need their own decision.

---

### Task 1: Pure respawn-decision utility

The whole fix lives in one predicate. Extracting it makes it testable — `useListData` is a React hook and cannot be unit-tested in this repo's node-only Vitest setup. This mirrors the existing pattern of `src/utils/reminder-suppression.ts`, `src/utils/unmark-completed.ts`, and `src/utils/list-archive.ts`.

**Files:**
- Create: `src/utils/recurring-respawn.ts`
- Test: `__tests__/unit/recurring-respawn.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RESPAWN_AFTER_MS: number`
  - `interface RespawnCandidate { recurring?: boolean; completed_at?: string | null; deleted_at?: string | null }`
  - `respawnAnchor(item: RespawnCandidate): string | null`
  - `shouldRespawn(item: RespawnCandidate, now: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/recurring-respawn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  RESPAWN_AFTER_MS,
  respawnAnchor,
  shouldRespawn,
} from "@/src/utils/recurring-respawn";

const NOW = new Date("2026-09-08T12:00:00.000Z").getTime();
const FIVE_HOURS_AGO = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
const ONE_HOUR_AGO = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();

describe("respawnAnchor", () => {
  it("is null for a non-recurring item", () => {
    expect(respawnAnchor({ recurring: false, completed_at: FIVE_HOURS_AGO })).toBe(null);
  });

  it("is the completion time for a completed recurring item", () => {
    expect(respawnAnchor({ recurring: true, completed_at: FIVE_HOURS_AGO })).toBe(
      FIVE_HOURS_AGO
    );
  });

  it("is null for a deleted recurring item — deleting is final", () => {
    expect(
      respawnAnchor({ recurring: true, completed_at: null, deleted_at: FIVE_HOURS_AGO })
    ).toBe(null);
  });

  it("is null when an item was completed and then deleted", () => {
    expect(
      respawnAnchor({
        recurring: true,
        completed_at: FIVE_HOURS_AGO,
        deleted_at: ONE_HOUR_AGO,
      })
    ).toBe(null);
  });

  it("is null for an active recurring item that has never been completed", () => {
    expect(respawnAnchor({ recurring: true, completed_at: null, deleted_at: null })).toBe(
      null
    );
  });
});

describe("shouldRespawn", () => {
  it("respawns a recurring item completed more than four hours ago", () => {
    expect(shouldRespawn({ recurring: true, completed_at: FIVE_HOURS_AGO }, NOW)).toBe(true);
  });

  it("does not respawn a recurring item completed one hour ago", () => {
    expect(shouldRespawn({ recurring: true, completed_at: ONE_HOUR_AGO }, NOW)).toBe(false);
  });

  it("never respawns a deleted item, however old the delete", () => {
    const ancient = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldRespawn({ recurring: true, deleted_at: ancient }, NOW)).toBe(false);
  });

  it("never respawns a deleted item whose stale completion is older than the window", () => {
    expect(
      shouldRespawn(
        { recurring: true, completed_at: FIVE_HOURS_AGO, deleted_at: ONE_HOUR_AGO },
        NOW
      )
    ).toBe(false);
  });

  it("never respawns a non-recurring completed item", () => {
    expect(shouldRespawn({ recurring: false, completed_at: FIVE_HOURS_AGO }, NOW)).toBe(false);
  });

  it("treats a missing recurring flag as not recurring", () => {
    expect(shouldRespawn({ completed_at: FIVE_HOURS_AGO }, NOW)).toBe(false);
  });

  it("exports the four-hour window", () => {
    expect(RESPAWN_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/recurring-respawn.test.ts`
Expected: FAIL — `Failed to resolve import "@/src/utils/recurring-respawn"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/recurring-respawn.ts`:

```ts
/**
 * When a recurring grocery staple comes back.
 *
 * Recurring items return to the active list 4 hours after being COMPLETED.
 * Deleting is final: a soft-deleted item never respawns, whatever else is set
 * on it. Before this rule existed the anchor fell through to `deleted_at`,
 * which made a deleted recurring item impossible to remove — it returned every
 * 4 hours forever, and the 7-day purge cron could never reach it because each
 * respawn cleared `deleted_at`.
 */

export const RESPAWN_AFTER_MS = 4 * 60 * 60 * 1000;

export interface RespawnCandidate {
  recurring?: boolean;
  completed_at?: string | null;
  deleted_at?: string | null;
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

export function shouldRespawn(item: RespawnCandidate, now: number): boolean {
  const anchor = respawnAnchor(item);
  if (anchor === null) return false;
  return now - new Date(anchor).getTime() > RESPAWN_AFTER_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/recurring-respawn.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/recurring-respawn.ts __tests__/unit/recurring-respawn.test.ts
git commit -m "feat: add respawn-anchor utility that refuses deleted items"
```

---

### Task 2: Wire the client respawn to the utility

**Files:**
- Modify: `src/hooks/useListData.ts:130-143`
- Test: covered by Task 1 (the hook itself is not unit-testable here); Task 3 adds the regression guard.

**Interfaces:**
- Consumes: `shouldRespawn` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

At the top of `src/hooks/useListData.ts`, alongside the existing imports:

```ts
import { shouldRespawn } from "@/src/utils/recurring-respawn";
```

- [ ] **Step 2: Replace the inline anchor logic**

Replace exactly this block (currently `src/hooks/useListData.ts:130-143`):

```ts
          // Auto-respawn recurring items past the same 4-hour threshold
          const respawnAnchor = base.completed_at ?? base.deleted_at ?? null;
          if (base.recurring && respawnAnchor && now - new Date(respawnAnchor).getTime() > FOUR_HOURS) {
            const currentJwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: base.id, restoreRecurring: true }),
            }).catch(() => {});
            return { ...base, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, position: Date.now() };
          }
```

with:

```ts
          // Auto-respawn recurring items past the same 4-hour threshold.
          // Deleting is final — shouldRespawn refuses any row carrying deleted_at.
          if (shouldRespawn(base, now)) {
            const currentJwt = jwtRef.current;
            fetch(`/api/lists/${listId}/items`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${currentJwt}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ itemId: base.id, restoreRecurring: true }),
            }).catch(() => {});
            return { ...base, completed: false, completed_at: null, skipped_at: null, ordered_at: null, position: Date.now() };
          }
```

Note `deleted_at: null` is gone from the returned object — a respawning row never had one.

- [ ] **Step 3: Verify FOUR_HOURS is still used**

Run: `grep -n "FOUR_HOURS" src/hooks/useListData.ts`
Expected: it still appears twice — the declaration at ~line 84 and the auto-unskip check at ~line 117. Auto-unskip is a separate feature and keeps its own constant. If it appears only once, the constant is now unused; delete the declaration.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useListData.ts
git commit -m "fix: stop respawning soft-deleted recurring items"
```

---

### Task 3: Stop shipping soft-deleted rows from GET

With Task 2 in place the client no longer resurrects these rows, so there is no reason to send them. Narrowing GET is what actually lets the 7-day purge cron reach them.

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts:35-41`
- Test: `__tests__/unit/no-deleted-item-leak.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

This follows the source-inspection pattern already used by `__tests__/unit/no-list-order-table.test.ts` — the query cannot be exercised without a database, and a regression here is silent.

Create `__tests__/unit/no-deleted-item-leak.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Deleting is final (docs/superpowers/specs/2026-09-08-delete-is-final-design.md).
// GET used to widen to `.or("deleted_at.is.null,recurring.eq.true")` so the client
// could respawn soft-deleted recurring rows. That made a recurring item impossible
// to delete and kept the 7-day purge cron from ever reaching it. A reintroduction
// compiles fine and fails only as returning-from-the-dead rows in production.
describe("GET /api/lists/[id]/items", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/api/lists/[id]/items/route.ts"),
    "utf8"
  );

  it("does not widen the item query to include soft-deleted recurring rows", () => {
    expect(source).not.toContain("recurring.eq.true");
  });

  it("filters items to non-deleted rows", () => {
    expect(source).toContain('.is("deleted_at", null)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/no-deleted-item-leak.test.ts`
Expected: FAIL on the first assertion — the source still contains `recurring.eq.true`.

- [ ] **Step 3: Narrow the query**

In `app/api/lists/[id]/items/route.ts`, replace this comment and line (currently lines 35-41):

```ts
  // Include active items (deleted_at IS NULL) and any recurring items even if soft-deleted,
  // so the client can auto-respawn deleted recurring items past the 4-hour threshold.
```

with:

```ts
  // Active items only. Deleting is final — a soft-deleted row is never returned,
  // never respawns, and is purged by the 7-day cleanup cron.
```

and replace:

```ts
    .or("deleted_at.is.null,recurring.eq.true")
```

with:

```ts
    .is("deleted_at", null)
```

Leave the `select(...)` list on line 39 unchanged — `recurring` is still needed to render the Recurring drawer and the 🔁 toggle state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/no-deleted-item-leak.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add "app/api/lists/[id]/items/route.ts" __tests__/unit/no-deleted-item-leak.test.ts
git commit -m "fix: GET /items no longer returns soft-deleted recurring rows"
```

---

### Task 4: Recurring drawer lists only completion-parked rows

`useListDerivedData` currently pulls deleted rows into the drawer via `|| !!i.deleted_at`. After Task 3 those rows never arrive, so the clause is dead — but leaving it means the drawer would silently repopulate if anything ever widens the query again. Extracting the predicate to `list-helpers.ts` makes it testable alongside the sibling section predicates.

**Files:**
- Modify: `src/utils/list-helpers.ts` (append)
- Modify: `src/hooks/useListDerivedData.ts:34-44`
- Modify: `components/list/RecurringItemsSection.tsx:64`
- Test: `__tests__/unit/item-sections.test.ts` (append)

**Interfaces:**
- Consumes: `respawnAnchor` from Task 1.
- Produces: `isParkedRecurringItem(i: ItemData): boolean` from `@/src/utils/list-helpers`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/unit/item-sections.test.ts`. The file already defines `makeItem` at the top; reuse it. Add `isParkedRecurringItem` to the existing import on line 2 so it reads:

```ts
import { isActiveItem, isSkippedItem, isParkedRecurringItem } from "@/src/utils/list-helpers";
```

Then append this block at the end of the file:

```ts
describe("isParkedRecurringItem", () => {
  it("parks a completed recurring item", () => {
    const i = makeItem({ recurring: true, completed: true, completed_at: "2026-09-08T00:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(true);
  });

  it("does not park a deleted recurring item — deleting is final", () => {
    const i = makeItem({
      recurring: true,
      completed: true,
      completed_at: "2026-09-08T00:00:00Z",
      deleted_at: "2026-09-08T01:00:00Z",
    });
    expect(isParkedRecurringItem(i)).toBe(false);
  });

  it("does not park a deleted recurring item that was never completed", () => {
    const i = makeItem({ recurring: true, deleted_at: "2026-09-08T01:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(false);
  });

  it("does not park an active recurring item", () => {
    const i = makeItem({ recurring: true });
    expect(isParkedRecurringItem(i)).toBe(false);
    expect(isActiveItem(i)).toBe(true);
  });

  it("does not park a completed non-recurring item", () => {
    const i = makeItem({ completed: true, completed_at: "2026-09-08T00:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/item-sections.test.ts`
Expected: FAIL — `isParkedRecurringItem` is not exported from `list-helpers`.

- [ ] **Step 3: Add the predicate**

Append to `src/utils/list-helpers.ts`:

```ts
// A recurring staple waiting to come back. Only completion parks an item here —
// deleting is final, so a soft-deleted row is never listed.
export const isParkedRecurringItem = (i: ItemData): boolean =>
  !!i.recurring && i.completed && !i.deleted_at;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/item-sections.test.ts`
Expected: PASS.

- [ ] **Step 5: Use the predicate in the hook**

In `src/hooks/useListDerivedData.ts`, add `isParkedRecurringItem` to the existing import from `@/src/utils/list-helpers` on line 5, and add a new import:

```ts
import { respawnAnchor } from "@/src/utils/recurring-respawn";
```

Then replace the `recurringItems` memo (currently lines 34-44):

```ts
  const recurringItems = useMemo(
    () =>
      items
        .filter((i) => i.recurring && (i.completed || !!i.deleted_at))
        .sort((a, b) => {
          const aTime = new Date(a.completed_at ?? a.deleted_at ?? 0).getTime();
          const bTime = new Date(b.completed_at ?? b.deleted_at ?? 0).getTime();
          return aTime - bTime;
        }),
    [items]
  );
```

with:

```ts
  const recurringItems = useMemo(
    () =>
      items
        .filter(isParkedRecurringItem)
        .sort((a, b) => {
          const aTime = new Date(respawnAnchor(a) ?? 0).getTime();
          const bTime = new Date(respawnAnchor(b) ?? 0).getTime();
          return aTime - bTime;
        }),
    [items]
  );
```

- [ ] **Step 6: Use the same anchor for the countdown**

In `components/list/RecurringItemsSection.tsx`, add:

```ts
import { respawnAnchor } from "@/src/utils/recurring-respawn";
```

and replace line 64:

```ts
            const anchor = item.completed_at ?? item.deleted_at ?? null;
```

with:

```ts
            const anchor = respawnAnchor(item);
```

This keeps the drawer's "returns in Xh" label and the code that actually fires the respawn reading from one function, so they cannot drift.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/utils/list-helpers.ts src/hooks/useListDerivedData.ts components/list/RecurringItemsSection.tsx __tests__/unit/item-sections.test.ts
git commit -m "fix: Recurring drawer lists only completion-parked items"
```

---

### Task 5: `restoreRecurring` stops clearing `deleted_at` server-side

The client is fixed, but the server still un-deletes anything. `restoreRecurring` sets `patchData.deleted_at = null`, which then makes `route.ts:354` skip the `.is("deleted_at", null)` guard — so the endpoint will resurrect **any** item id, and it never checks the `recurring` column at all. Removing that one assignment makes the existing guard protect deleted rows for free, and closes the same hole for a replayed offline `restore-recurring` mutation.

**Files:**
- Modify: `app/api/lists/[id]/items/route.ts:325-333`
- Test: `__tests__/unit/no-deleted-item-leak.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/unit/no-deleted-item-leak.test.ts`, inside the existing `describe` block (it already reads the same `source`):

```ts
  it("restoreRecurring does not clear deleted_at", () => {
    const branch = source.slice(
      source.indexOf("if (updates.restoreRecurring === true)"),
      source.indexOf("// Allow restoring soft-deleted items")
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toContain("deleted_at");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/no-deleted-item-leak.test.ts`
Expected: FAIL — the branch still contains `patchData.deleted_at = null;`.

- [ ] **Step 3: Remove the assignment**

In `app/api/lists/[id]/items/route.ts`, replace this block (currently lines 325-333):

```ts
  // Bring a recurring item back to active: clear all "out-of-active" flags atomically.
  if (updates.restoreRecurring === true) {
    patchData.completed = false;
    patchData.completed_at = null;
    patchData.deleted_at = null;
    patchData.skipped_at = null;
    patchData.ordered_at = null;
    patchData.position = Date.now();
  }
```

with:

```ts
  // Bring a recurring item back to active: clear all "out-of-active" flags atomically.
  // deleted_at is deliberately NOT cleared — deleting is final, and leaving it out
  // means the `.is("deleted_at", null)` guard below still applies to this branch,
  // so a stale queued restore can never resurrect a row someone has since deleted.
  if (updates.restoreRecurring === true) {
    patchData.completed = false;
    patchData.completed_at = null;
    patchData.skipped_at = null;
    patchData.ordered_at = null;
    patchData.position = Date.now();
  }
```

Leave the separate undo branch (`if (updates.deleted_at === null)`) and the guard at line 354 untouched — Undo still restores, and that is the intended manual gesture.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/no-deleted-item-leak.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "app/api/lists/[id]/items/route.ts" __tests__/unit/no-deleted-item-leak.test.ts
git commit -m "fix: restoreRecurring no longer un-deletes items"
```

---

### Task 6: Full verification

**Files:** none modified.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all files pass. Verified baseline before this plan is **18 files, 116 tests**; expect 20 files and 116 + 12 (Task 1) + 5 (Task 4) + 3 (Tasks 3 and 5) = **136 tests**.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Lint**

Run: `npx eslint .`
Expected: exactly 6 problems (3 errors, 3 warnings), all pre-existing, in `app/login/callback/page.tsx`, `components/TimePicker.tsx`, `components/ReminderSheet.tsx`, `src/hooks/useItemHandlers.ts`. Any other file appearing is a regression introduced by this plan.

- [ ] **Step 4: Confirm no migration was added**

Run: `git diff --stat main -- supabase/migrations/`
Expected: empty. This change needs no schema change and no backfill — existing `recurring = true AND deleted_at IS NOT NULL` rows simply stop being returned and are purged by the existing 7-day cron.

- [ ] **Step 5: Manual check on the deployed app**

1. In a grocery list, mark an item recurring (🔁), complete it, and confirm it appears in the Recurring drawer with a "returns in ~4 hours" label.
2. Delete a *different* recurring item from the active list. Confirm it does **not** appear in the Recurring drawer, and does not come back after a reload.
3. Delete one and immediately tap **Undo**. Confirm it returns, still marked recurring.
4. Confirm the previously stuck "olive oil" row is gone from the list and does not return.

---

## Follow-up, not in this plan

Recorded in the spec's Scope section; each needs its own decision before any code:

1. **The duplicate-creation half.** `useItemHandlers.ts:114-116` inspects only active rows and never blocks the insert; voice add cannot see active rows at all, because `find_fuzzy_items` filters `completed = true AND deleted_at IS NULL` (live definition: `supabase/migrations/010_position_bigint.sql:56-76`). This is the other half of the original bug report.
2. **`recycleId` is unvalidated.** `items/route.ts:225` passes a client-supplied id into `recycleItem`, which has no `deleted_at` guard and no `list_id` scoping (`item-recycler.ts:79-92`) — a cross-list write vector.
3. **Grocery lists have no non-destructive clear.** "Unmark all done" is gated to `listType === "regular"` (`app/list/[id]/page.tsx:303`), so a grocery list's only completed-section action is the destructive one.
4. **The 🔁 toggle has no undo and no label** (`components/ItemRow.tsx:236-255`) — the likeliest way an item gets marked recurring by accident.
