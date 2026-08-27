# Manual List Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drag lists into any order they like on the home screen, with that order stored per-user so it never leaks between collaborators on a shared list.

**Architecture:** A new sparse `list_order(user_id, list_id, position)` table holds each user's manual order; `GET /api/lists` joins it and sorts in JS (unordered lists first, then positioned lists highest-position-first); a new collection-level `POST /api/lists/reorder` bulk-upserts the whole ordered array. The frontend mirrors the existing item drag pattern exactly — a module-scope 400 ms long-press `PointerSensor`, `useSortable`, and a `DragDropProvider` around the card map — but writes through a plain optimistic `fetch` rather than the mutation queue, matching every other home-screen mutation.

**Tech Stack:** Next.js 16.1.6 (App Router), React 19.2.3, TypeScript, Supabase (postgres-js migrations run at build time), `@dnd-kit/react` 0.2.4 + `@dnd-kit/dom`, `next-intl`, Zod 4, Vitest (node environment, no jsdom).

**Spec:** `docs/superpowers/specs/2026-08-27-list-manual-reorder-design.md`

## Global Constraints

- **Position column must be `BIGINT`, never `INTEGER`.** Migration `010_position_bigint.sql` exists because a client wrote `Date.now()` into an `INTEGER` position and overflowed it.
- **Highest position renders first.** This matches the items convention (`app/api/lists/[id]/items/reorder/route.ts:38-40`, `src/hooks/useListDragDrop.ts:70-74`). Do not invert it.
- **Migrations are append-only** files named `NNN_snake_case.sql` in `supabase/migrations/`, applied lexicographically by `scripts/migrate.mjs` during `npm run build`. The next free number is `024`. Never edit an existing migration. They run with **no surrounding transaction**, so DDL must be safe on partial failure.
- **Every new table must `ENABLE ROW LEVEL SECURITY`** (rule set in `008_security_fixes.sql`). All API writes use the service-role client, which bypasses RLS; the policy exists to satisfy the Supabase Security Advisor.
- **Tests are `__tests__/**/*.test.ts` only.** `vitest.config.ts:11` does not match `.tsx`, and there is no jsdom environment — a component test would be silently skipped or crash on `document is not defined`. Test pure functions only.
- **`messages/en.json`, `messages/he.json`, `messages/ru.json` must stay key-for-key identical**, with keys added at the same position in all three. They are currently 204 leaf keys each.
- **`app/page.tsx` uses the root `useTranslations()` style** with fully-dotted keys (`t('lists.reorderFailed')`). `components/*.tsx` mostly use the namespaced style (`useTranslations('lists')` → `t('reorderFailed')`). Match the file you are editing.
- **`useSortable` is imported from `@dnd-kit/react/sortable`**, not from `@dnd-kit/react`. `DragDropProvider` comes from `@dnd-kit/react`. Sensors come from `@dnd-kit/dom`.
- **`npm run build` may fail with an `ENVIRONMENT_FALLBACK` error** during static generation because env vars are absent locally. That failure is pre-existing and unrelated. Verify with `npx tsc --noEmit` and `npx vitest run` instead.
- **Do not add a `src/utils/executor-factory.ts` case.** This feature deliberately bypasses the mutation queue. (The repo's usual trap is the opposite: a *queued* mutation type missing a factory case is silently dropped on offline replay.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/list-order.ts` (new) | Pure ordering logic: the home-screen comparator and the upsert-row builder. No I/O, no React. |
| `__tests__/unit/list-order.test.ts` (new) | Unit tests for the above, including a regression guard that an empty position map reproduces today's ordering. |
| `__tests__/unit/locale-parity.test.ts` (new) | Guard test: `en`/`he`/`ru` must have identical leaf-key sets. |
| `supabase/migrations/024_list_order.sql` (new) | The `list_order` table, its RLS policy, and a missing index on `lists.owner_id`. |
| `src/schemas/lists.ts` (modify) | Add `reorderListsSchema`. |
| `app/api/lists/reorder/route.ts` (new) | `POST` handler: auth, visibility filter, single bulk upsert. |
| `app/api/lists/route.ts` (modify) | `GET` fetches the caller's order rows and sorts the response. |
| `components/SortableListCard.tsx` (new) | Drag wrapper around `ListCard`. Mirror of `components/SortableItem.tsx`. |
| `src/hooks/useListsDragDrop.ts` (new) | Drag handlers, optimistic reorder, `POST`, rollback, click-suppression ref. |
| `app/page.tsx` (modify) | Wrap the card map in `DragDropProvider`, guard navigation, generalise the toast, fix the delete-undo restore position. |
| `messages/{en,he,ru}.json` (modify) | `lists.reorderFailed`. |
| `package.json` (modify) | Promote `@dnd-kit/dom` to a direct dependency. |

---

### Task 1: Pure ordering helpers

**Files:**
- Create: `src/utils/list-order.ts`
- Test: `__tests__/unit/list-order.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface OrderableList { id: string; owner_id: string; updated_at: string }`
  - `sortListsByUserOrder<T extends OrderableList>(lists: T[], positions: Map<string, number>, userId: string): T[]`
  - `buildListOrderRows(userId: string, orderedIds: string[]): { user_id: string; list_id: string; position: number }[]`

Both are used by Task 4 (`GET /api/lists`) and Task 5 (`POST /api/lists/reorder`).

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/list-order.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  sortListsByUserOrder,
  buildListOrderRows,
  type OrderableList,
} from "@/src/utils/list-order";

const ME = "user-me";
const OTHER = "user-other";

// Full-shape factory so fixtures stay valid if OrderableList grows.
function makeList(overrides: Partial<OrderableList> = {}): OrderableList {
  return {
    id: "list-1",
    owner_id: ME,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ids = (lists: OrderableList[]) => lists.map((l) => l.id);

describe("sortListsByUserOrder", () => {
  it("sorts unpositioned lists above positioned ones", () => {
    const lists = [
      makeList({ id: "positioned" }),
      makeList({ id: "fresh" }),
    ];
    const positions = new Map([["positioned", 5]]);

    expect(ids(sortListsByUserOrder(lists, positions, ME))).toEqual([
      "fresh",
      "positioned",
    ]);
  });

  it("sorts positioned lists by position descending (highest first)", () => {
    const lists = [
      makeList({ id: "low" }),
      makeList({ id: "high" }),
      makeList({ id: "mid" }),
    ];
    const positions = new Map([
      ["low", 1],
      ["mid", 2],
      ["high", 3],
    ]);

    expect(ids(sortListsByUserOrder(lists, positions, ME))).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("puts owned lists before shared ones among unpositioned lists", () => {
    const lists = [
      makeList({ id: "shared", owner_id: OTHER, updated_at: "2026-05-01T00:00:00.000Z" }),
      makeList({ id: "owned", owner_id: ME, updated_at: "2026-01-01T00:00:00.000Z" }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "owned",
      "shared",
    ]);
  });

  it("breaks ties among equally-owned unpositioned lists by updated_at descending", () => {
    const lists = [
      makeList({ id: "older", updated_at: "2026-01-01T00:00:00.000Z" }),
      makeList({ id: "newer", updated_at: "2026-06-01T00:00:00.000Z" }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "newer",
      "older",
    ]);
  });

  // Regression guard: a user who has never dragged must see exactly the
  // ordering GET /api/lists produced before this feature existed —
  // all owned lists (newest-updated first), then all shared lists.
  it("reproduces the pre-feature ordering when no positions exist", () => {
    const lists = [
      makeList({ id: "shared-new", owner_id: OTHER, updated_at: "2026-07-01T00:00:00.000Z" }),
      makeList({ id: "owned-old", owner_id: ME, updated_at: "2026-02-01T00:00:00.000Z" }),
      makeList({ id: "shared-old", owner_id: OTHER, updated_at: "2026-03-01T00:00:00.000Z" }),
      makeList({ id: "owned-new", owner_id: ME, updated_at: "2026-06-01T00:00:00.000Z" }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "owned-new",
      "owned-old",
      "shared-new",
      "shared-old",
    ]);
  });

  it("is deterministic for exact ties by falling back to id", () => {
    const lists = [makeList({ id: "b" }), makeList({ id: "a" })];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const lists = [makeList({ id: "b" }), makeList({ id: "a" })];
    const before = ids(lists);

    sortListsByUserOrder(lists, new Map(), ME);

    expect(ids(lists)).toEqual(before);
  });
});

describe("buildListOrderRows", () => {
  it("gives the first id the highest position and the last id 1", () => {
    const rows = buildListOrderRows(ME, ["top", "middle", "bottom"]);

    expect(rows).toEqual([
      { user_id: ME, list_id: "top", position: 3 },
      { user_id: ME, list_id: "middle", position: 2 },
      { user_id: ME, list_id: "bottom", position: 1 },
    ]);
  });

  it("returns an empty array for no ids", () => {
    expect(buildListOrderRows(ME, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/unit/list-order.test.ts`
Expected: FAIL — `Failed to resolve import "@/src/utils/list-order"`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/list-order.ts`:

```ts
/**
 * Per-user manual ordering of the home screen list.
 *
 * Positions are sparse: a list only has one once the user has actually
 * dragged. Unpositioned lists (just created, just shared with you, never
 * touched) sort ABOVE the manual order so they are immediately visible.
 */

export interface OrderableList {
  id: string;
  owner_id: string;
  updated_at: string;
}

/**
 * Sort lists for a user's home screen.
 *
 * - Unpositioned lists come first.
 * - Among positioned lists: highest position first (matches the item
 *   convention, where the top row carries the largest position).
 * - Among unpositioned lists: owned before shared, then updated_at
 *   descending — exactly the ordering GET /api/lists produced before this
 *   feature, so a user who never drags sees no change.
 * - Exact ties fall back to id so the output is deterministic.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortListsByUserOrder<T extends OrderableList>(
  lists: T[],
  positions: Map<string, number>,
  userId: string
): T[] {
  return [...lists].sort((a, b) => {
    const pa = positions.get(a.id);
    const pb = positions.get(b.id);

    if (pa != null && pb != null) {
      if (pa !== pb) return pb - pa;
    } else if (pa != null || pb != null) {
      // Exactly one is positioned — the unpositioned one wins.
      return pa == null ? -1 : 1;
    } else {
      const aOwned = a.owner_id === userId;
      const bOwned = b.owner_id === userId;
      if (aOwned !== bOwned) return aOwned ? -1 : 1;

      if (a.updated_at !== b.updated_at) {
        return a.updated_at < b.updated_at ? 1 : -1;
      }
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Rows for the bulk upsert into list_order. The first id (top of the
 * screen) gets the highest position, the last gets 1.
 */
export function buildListOrderRows(
  userId: string,
  orderedIds: string[]
): { user_id: string; list_id: string; position: number }[] {
  return orderedIds.map((listId, index) => ({
    user_id: userId,
    list_id: listId,
    position: orderedIds.length - index,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/unit/list-order.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add src/utils/list-order.ts __tests__/unit/list-order.test.ts
git commit -m "feat: add pure helpers for per-user list ordering"
```

---

### Task 2: Locale key-parity guard + the failure-toast string

**Files:**
- Create: `__tests__/unit/locale-parity.test.ts`
- Modify: `messages/en.json:59` (after `"color"`), `messages/he.json:59`, `messages/ru.json:59`

**Interfaces:**
- Consumes: nothing.
- Produces: the i18n key `lists.reorderFailed`, used by Task 7.

The guard test is written first and will pass immediately (the files are already in sync). Adding the key to `en.json` alone then breaks it, proving the guard works, and adding it to `he.json` and `ru.json` restores it. That is the TDD cycle for this task.

- [ ] **Step 1: Write the guard test**

Create `__tests__/unit/locale-parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Hard-coded rather than imported from src/lib/i18n.ts: that module pulls in
// next-intl/server, which does not load in the node test environment.
// Keep in sync with `supportedLocales` there.
const LOCALES = ["en", "he", "ru"];

type Json = { [key: string]: string | Json };

function leafKeys(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null
      ? leafKeys(value as Json, path)
      : [path];
  });
}

function load(locale: string): Json {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `messages/${locale}.json`), "utf8")
  );
}

describe("locale key parity", () => {
  // Guards the silent-break bug: adding a key to en.json only ships a raw
  // key path ("lists.reorderFailed") to Hebrew and Russian users.
  const base = leafKeys(load("en")).sort();

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`messages/${locale}.json has exactly the same keys as en.json`, () => {
      const keys = leafKeys(load(locale)).sort();

      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));

      expect(missing, `missing from ${locale}.json: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `not in en.json: ${extra.join(", ")}`).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it to confirm it passes on the current files**

Run: `npx vitest run __tests__/unit/locale-parity.test.ts`
Expected: PASS, 2 tests (`he`, `ru`).

If `supportedLocales` is not exported from `src/lib/i18n.ts`, export it there (it is declared at line 5) rather than hard-coding the list.

- [ ] **Step 3: Add the key to `en.json` only, and watch the guard fail**

In `messages/en.json`, change line 59 from `    "color": "Color"` to:

```json
    "color": "Color",
    "reorderFailed": "Couldn't save the new order"
```

Run: `npx vitest run __tests__/unit/locale-parity.test.ts`
Expected: FAIL — both `he` and `ru` report `missing from …: lists.reorderFailed`.

- [ ] **Step 4: Add the key to `he.json` and `ru.json` at the same position**

In `messages/he.json`, change line 59 from `    "color": "צבע"` to:

```json
    "color": "צבע",
    "reorderFailed": "לא הצלחנו לשמור את הסדר החדש"
```

In `messages/ru.json`, change line 59 from `    "color": "Цвет"` to:

```json
    "color": "Цвет",
    "reorderFailed": "Не удалось сохранить новый порядок"
```

- [ ] **Step 5: Run the guard again**

Run: `npx vitest run __tests__/unit/locale-parity.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add __tests__/unit/locale-parity.test.ts messages/en.json messages/he.json messages/ru.json src/lib/i18n.ts
git commit -m "feat: add reorderFailed string and a locale key-parity guard test"
```

---

### Task 3: Migration and request schema

**Files:**
- Create: `supabase/migrations/024_list_order.sql`
- Modify: `src/schemas/lists.ts` (append after `updateListSchema`)

**Interfaces:**
- Consumes: nothing.
- Produces: the `list_order` table and `reorderListsSchema`, both used by Tasks 4 and 5.

There is no test harness for SQL or for Zod schemas in this repo (`__tests__/` contains only pure-function tests, and Supabase is never mocked). Verification is a typecheck plus reading the SQL back.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/024_list_order.sql`:

```sql
-- Per-user manual ordering of the home screen list.
-- Sparse: a row exists only once a user has actually dragged a list.
-- Owner and collaborator are treated identically — `collaborators` has no
-- row for the owner, so it cannot carry the owner's own order.
CREATE TABLE list_order (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id  UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  PRIMARY KEY (user_id, list_id)
);

-- The primary key already indexes (user_id, ...), which serves the only
-- read pattern: WHERE user_id = $1 AND list_id IN (...).

ALTER TABLE list_order ENABLE ROW LEVEL SECURITY;

CREATE POLICY "list_order_select_own" ON list_order FOR SELECT
  USING (user_id = auth.uid());

-- GET /api/lists filters lists on owner_id and there has never been an
-- index for it.
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id) WHERE deleted_at IS NULL;
```

- [ ] **Step 2: Verify the migration is well-formed and correctly numbered**

Run: `ls supabase/migrations | tail -3 && cat supabase/migrations/024_list_order.sql`
Expected: `024_list_order.sql` is the highest-numbered file, and the SQL reads back as written. Confirm the position column is `BIGINT` and that `ENABLE ROW LEVEL SECURITY` is present.

- [ ] **Step 3: Add the request schema**

In `src/schemas/lists.ts`, append after `updateListSchema` (the file currently ends at line 22):

```ts
// POST /api/lists/reorder
// .uuid() rather than the items schema's .min(1): list creation on the home
// screen is server-first, so there are no optimistic `temp-` ids to accept.
export const reorderListsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/024_list_order.sql src/schemas/lists.ts
git commit -m "feat: add list_order table and reorder request schema"
```

---

### Task 4: `POST /api/lists/reorder`

**Files:**
- Create: `app/api/lists/reorder/route.ts`

**Interfaces:**
- Consumes: `buildListOrderRows` (Task 1), `reorderListsSchema` (Task 3), the `list_order` table (Task 3).
- Produces: `POST /api/lists/reorder` accepting `{ orderedIds: string[] }` and returning `{ updated: number }`. Called by Task 6.

Note this is a **collection-level** route (`app/api/lists/reorder/`), not under `[id]`. There is no `app/api/lists/[id]/route.ts` in this repo; all list CRUD is collection-level, and a reorder spans lists so it has no single list id.

- [ ] **Step 1: Write the route**

Create `app/api/lists/reorder/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { reorderListsSchema } from "@/src/schemas/lists";
import { parseBody } from "@/src/lib/api-validation";
import { buildListOrderRows } from "@/src/utils/list-order";

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-reorder");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const parsed = parseBody(reorderListsSchema, body);
  if (!parsed.success) return parsed.response;

  const orderedIds: string[] = parsed.data.orderedIds;
  const supabase = createServerClient();

  // Deliberately NOT verifyListPermission(..., "edit"): reordering your own
  // home screen is not editing anyone's list, so a view-only collaborator
  // may reorder. Instead, filter down to lists this user can actually see —
  // the same visibility rule GET /api/lists uses.
  const [{ data: owned }, { data: collab }] = await Promise.all([
    supabase
      .from("lists")
      .select("id")
      .eq("owner_id", auth.userId)
      .is("deleted_at", null)
      .in("id", orderedIds),
    supabase
      .from("collaborators")
      .select("list_id")
      .eq("user_id", auth.userId)
      .eq("status", "approved")
      .in("list_id", orderedIds),
  ]);

  const visible = new Set<string>([
    ...(owned || []).map((l) => l.id),
    ...(collab || []).map((c) => c.list_id),
  ]);

  // Ids the caller cannot see are dropped silently rather than 4xx'd — a list
  // deleted concurrently in another tab must not fail the whole reorder.
  const allowedIds = orderedIds.filter((id) => visible.has(id));
  if (allowedIds.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  // One statement, not N parallel updates: a partial reorder is never
  // observable.
  const rows = buildListOrderRows(auth.userId, allowedIds);
  const { error } = await supabase
    .from("list_order")
    .upsert(rows, { onConflict: "user_id,list_id" });

  if (error) {
    console.error("[lists-reorder] Upsert failed:", error);
    return NextResponse.json(
      { error: "Failed to save list order" },
      { status: 500 }
    );
  }

  return NextResponse.json({ updated: rows.length });
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app/api/lists/reorder/route.ts`
Expected: no output from either (success).

- [ ] **Step 3: Run the full unit suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: all test files pass.

- [ ] **Step 4: Commit**

```bash
git add app/api/lists/reorder/route.ts
git commit -m "feat: add POST /api/lists/reorder endpoint"
```

---

### Task 5: Apply the order in `GET /api/lists`

**Files:**
- Modify: `app/api/lists/route.ts:48-94` (inside `GET`)

**Interfaces:**
- Consumes: `sortListsByUserOrder` (Task 1), the `list_order` table (Task 3).
- Produces: `GET /api/lists` returning the array in the caller's manual order. Response *shape* is unchanged — no new fields.

- [ ] **Step 1: Add the import**

At the top of `app/api/lists/route.ts`, after the existing `parseBody` import (line 6):

```ts
import { sortListsByUserOrder } from "@/src/utils/list-order";
```

- [ ] **Step 2: Fetch the caller's order rows**

In `GET`, immediately after the `sharedSet` block (which ends at line 76 with the closing `}` of `if (listIds.length > 0)`), insert:

```ts
  // The caller's manual order. Sparse — only lists they have dragged appear.
  const positions = new Map<string, number>();
  if (listIds.length > 0) {
    const { data: orderRows } = await supabase
      .from("list_order")
      .select("list_id, position")
      .eq("user_id", auth.userId)
      .in("list_id", listIds);
    for (const row of orderRows || []) {
      positions.set(row.list_id, Number(row.position));
    }
  }
```

`Number(...)` matters: `BIGINT` arrives from PostgREST as a string.

- [ ] **Step 3: Sort the response**

Replace the final line of `GET` (line 94, `return NextResponse.json(listsWithCounts);`) with:

```ts
  return NextResponse.json(
    sortListsByUserOrder(listsWithCounts, positions, auth.userId)
  );
```

Leave the per-query `.order("updated_at", { ascending: false })` calls (lines 20 and 38) in place — they are the input the comparator falls back to.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app/api/lists/route.ts`
Expected: no output from either.

The `listsWithCounts` elements carry `id`, `owner_id`, and `updated_at`, which satisfies the `OrderableList` constraint. If `tsc` complains that `role` widens to `string`, that is pre-existing inference on the `role` ternary and is unrelated — the generic only constrains the three fields it names.

- [ ] **Step 5: Commit**

```bash
git add app/api/lists/route.ts
git commit -m "feat: order GET /api/lists by the caller's manual list order"
```

---

### Task 6: Drag components — `SortableListCard` and `useListsDragDrop`

**Files:**
- Create: `components/SortableListCard.tsx`
- Create: `src/hooks/useListsDragDrop.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: `POST /api/lists/reorder` (Task 4).
- Produces:
  - `SortableListCard` — every prop of `ListCard` plus `index: number`.
  - `useListsDragDrop({ lists, setLists, jwtRef, onReorderFailed })` returning `{ handleDragStart, handleDragEnd, suppressClickRef }`.

Both are consumed by Task 7.

- [ ] **Step 1: Promote `@dnd-kit/dom` to a direct dependency**

`components/SortableItem.tsx:4` already imports from `@dnd-kit/dom`, but it is only a transitive dependency of `@dnd-kit/react`. The new component imports it too, so make it explicit.

Run: `npm install --save-exact @dnd-kit/dom@$(node -p "require('@dnd-kit/dom/package.json').version")`
Expected: `@dnd-kit/dom` appears in `package.json` dependencies at the already-installed version (0.2.4). `package-lock.json` is updated.

- [ ] **Step 2: Write `SortableListCard`**

Create `components/SortableListCard.tsx`:

```tsx
"use client";

import { useSortable } from "@dnd-kit/react/sortable";
import { PointerSensor, PointerActivationConstraints } from "@dnd-kit/dom";
import ListCard from "./ListCard";
import type { ListColor, ListIconName, ListType } from "@/src/lib/list-icons";

// Module scope is load-bearing: a sensor created in the component body gets a
// new identity on every render and long-press activation stops working.
const longPressSensor = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Delay({ value: 400, tolerance: 5 }),
  ],
});

interface SortableListCardProps {
  id: string;
  index: number;
  name: string;
  type: ListType;
  icon: ListIconName | null;
  color: ListColor | null;
  activeCount: number;
  completedCount: number;
  isShared: boolean;
  role: "owner" | "view" | "edit";
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function SortableListCard({
  id,
  index,
  name,
  type,
  icon,
  color,
  activeCount,
  completedCount,
  isShared,
  role,
  onClick,
  onEdit,
  onDelete,
}: SortableListCardProps) {
  const { ref, isDragSource } = useSortable({
    id,
    index,
    sensors: [longPressSensor],
  });

  return (
    <div
      ref={ref}
      className={`touch-pan-y select-none transition-transform duration-150 ${isDragSource ? "opacity-50 scale-[1.02] shadow-lg rounded-2xl" : ""}`}
    >
      <ListCard
        id={id}
        name={name}
        type={type}
        icon={icon}
        color={color}
        activeCount={activeCount}
        completedCount={completedCount}
        isShared={isShared}
        role={role}
        onClick={onClick}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}
```

`rounded-2xl` (not `rounded-xl` as in `SortableItem`) because `ListCard`'s root uses `rounded-2xl`.

- [ ] **Step 3: Write the drag hook**

Create `src/hooks/useListsDragDrop.ts`:

```ts
"use client";

import { useRef, useCallback } from "react";
import type { DragDropEvents } from "@dnd-kit/react";
import { getTelegramWebApp } from "@/src/types/telegram";

interface ReorderableList {
  id: string;
}

interface UseListsDragDropParams<T extends ReorderableList> {
  lists: T[];
  setLists: React.Dispatch<React.SetStateAction<T[]>>;
  jwtRef: React.RefObject<string | null>;
  onReorderFailed: () => void;
}

export function useListsDragDrop<T extends ReorderableList>({
  lists,
  setLists,
  jwtRef,
  onReorderFailed,
}: UseListsDragDropParams<T>) {
  const previousListsRef = useRef<T[]>([]);
  // ListCard's root is a <button> that navigates. A long-press fires a click
  // on release even when it started a drag, so navigation is suppressed for a
  // tick after the gesture ends. Item rows never needed this — they don't
  // navigate.
  const suppressClickRef = useRef(false);

  const releaseClickGuard = useCallback(() => {
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragStart: DragDropEvents["dragstart"] = useCallback(() => {
    previousListsRef.current = [...lists];
    suppressClickRef.current = true;
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("medium");
  }, [lists]);

  const handleDragEnd: DragDropEvents["dragend"] = useCallback(
    (event) => {
      if (event.canceled) {
        setLists(previousListsRef.current);
        releaseClickGuard();
        return;
      }

      const { source, target } = event.operation;
      if (!source || !target) {
        releaseClickGuard();
        return;
      }

      const sourceId = source.id as string;
      // `sortable` exists at runtime but not on the base Draggable type.
      const projectedIndex = (source as { sortable?: { index: number } })
        .sortable?.index;
      const originalIndex = lists.findIndex((l) => l.id === sourceId);

      if (
        originalIndex === -1 ||
        projectedIndex == null ||
        originalIndex === projectedIndex
      ) {
        releaseClickGuard();
        return;
      }

      const reordered = [...lists];
      const [moved] = reordered.splice(originalIndex, 1);
      reordered.splice(projectedIndex, 0, moved);

      const snapshot = previousListsRef.current;
      const orderedIds = reordered.map((l) => l.id);

      setLists(reordered);
      releaseClickGuard();

      const jwt = jwtRef.current;
      fetch("/api/lists/reorder", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orderedIds }),
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
        })
        .catch((e) => {
          console.error("[Home] Reorder error:", e);
          setLists(snapshot);
          onReorderFailed();
        });
    },
    [lists, setLists, jwtRef, onReorderFailed, releaseClickGuard]
  );

  return { handleDragStart, handleDragEnd, suppressClickRef };
}
```

Every early return calls `releaseClickGuard()`. The item hook resets its equivalent ref in five separate places; missing one here leaves taps permanently dead.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint components/SortableListCard.tsx src/hooks/useListsDragDrop.ts`
Expected: no output from either.

- [ ] **Step 5: Commit**

```bash
git add components/SortableListCard.tsx src/hooks/useListsDragDrop.ts package.json package-lock.json
git commit -m "feat: add sortable list card and home-screen drag hook"
```

---

### Task 7: Wire drag into the home screen

**Files:**
- Modify: `app/page.tsx` — imports, `undoAction` state (lines 48-52), `handleDeleteList` undo (line 232), the card map (lines 406-424), the toast render (lines 486-496)

**Interfaces:**
- Consumes: `SortableListCard` and `useListsDragDrop` (Task 6), `lists.reorderFailed` (Task 2), `POST /api/lists/reorder` (Task 4).
- Produces: the finished feature.

- [ ] **Step 1: Add imports**

After the existing `ListCard` import (line 8), add:

```tsx
import SortableListCard from "@/components/SortableListCard";
```

and after the `lucide-react` import (line 6), add:

```tsx
import { DragDropProvider } from "@dnd-kit/react";
import { useListsDragDrop } from "@/src/hooks/useListsDragDrop";
```

`ListCard` is no longer rendered directly by this file, so remove its import if `npx eslint` flags it as unused.

- [ ] **Step 2: Generalise the toast so it can show a message with no Undo**

At lines 48-52, change:

```tsx
  const [undoAction, setUndoAction] = useState<{
    message: string;
    undo: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);
```

to:

```tsx
  // Bottom toast. `undo` is optional — reorder failures show a message only.
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
    timeout: NodeJS.Timeout;
  } | null>(null);
```

Then rename every remaining `undoAction` → `toast` and `setUndoAction` → `setToast` in the file (they appear in `handleDeleteList` around lines 216-244 and in the render around lines 486-496).

- [ ] **Step 3: Render the Undo button only when there is an undo**

At lines 486-496, change the toast block's button to be conditional:

```tsx
      {/* Bottom toast */}
      {toast && (
        <div className="fixed bottom-8 start-5 end-5 bg-foreground text-background rounded-2xl py-3.5 px-5 flex items-center justify-between z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{toast.message}</span>
          {toast.undo && (
            <button onClick={toast.undo} className="text-sm font-semibold ms-4">
              {t('common.undo')}
            </button>
          )}
        </div>
      )}
```

- [ ] **Step 4: Fix the delete-undo restore position**

In `handleDeleteList`, the undo callback currently restores with `setLists((prev) => [...prev, listToDelete]);` (line 232), appending the list at the end and losing its place. With an explicit order that is visibly wrong. Capture the index before the optimistic removal and splice it back.

Change the optimistic removal (line 216) from:

```tsx
      setLists((prev) => prev.filter((l) => l.id !== listToDelete.id));
```

to:

```tsx
      const deletedIndex = lists.findIndex((l) => l.id === listToDelete.id);
      setLists((prev) => prev.filter((l) => l.id !== listToDelete.id));
```

and the undo restore (line 232) from:

```tsx
          setLists((prev) => [...prev, listToDelete]);
```

to:

```tsx
          setLists((prev) => {
            const next = [...prev];
            next.splice(
              deletedIndex === -1 ? next.length : deletedIndex,
              0,
              listToDelete
            );
            return next;
          });
```

Add `lists` to the `useCallback` dependency array of `handleDeleteList` (currently `[jwtRef, t]` at line 264) so `deletedIndex` is computed against current state: `[lists, jwtRef, t]`.

- [ ] **Step 5: Instantiate the drag hook**

After `fetchLists` is defined (it ends at line 111) and before the `useEffect` that calls it, add:

```tsx
  const handleReorderFailed = useCallback(() => {
    setToast((prev) => {
      if (prev) clearTimeout(prev.timeout);
      return {
        message: t('lists.reorderFailed'),
        timeout: setTimeout(() => setToast(null), 4000),
      };
    });
    fetchLists();
  }, [t, fetchLists]);

  const { handleDragStart, handleDragEnd, suppressClickRef } = useListsDragDrop({
    lists,
    setLists,
    jwtRef,
    onReorderFailed: handleReorderFailed,
  });
```

- [ ] **Step 6: Wrap the card map and guard navigation**

Replace lines 406-424 (the `<div className="flex-1 px-5 pt-3 pb-24 space-y-3">` block) with:

```tsx
      <div className="flex-1 px-5 pt-3 pb-24 space-y-3">
        <DragDropProvider onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {lists.map((list, index) => (
            <SortableListCard
              key={list.id}
              id={list.id}
              index={index}
              name={list.name}
              type={list.type}
              icon={list.icon}
              color={list.color}
              activeCount={list.active_count}
              completedCount={list.completed_count}
              isShared={list.is_shared}
              role={list.role}
              onClick={() => {
                // A long-press that started a drag still fires a click on
                // release — don't navigate on it.
                if (suppressClickRef.current) return;
                router.push(`/list/${list.id}`);
              }}
              onEdit={list.role === "owner" ? () => handleEditList(list) : undefined}
              onDelete={list.role === "owner" ? () => handleDeleteList(list) : undefined}
            />
          ))}
        </DragDropProvider>
      </div>
```

- [ ] **Step 7: Typecheck, lint, and run the full suite**

Run: `npx tsc --noEmit && npx eslint app/page.tsx && npx vitest run`
Expected: no output from `tsc` or `eslint`; all vitest files pass.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx
git commit -m "feat: drag to reorder lists on the home screen"
```

---

### Task 8: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the whole unit suite**

Run: `npx vitest run`
Expected: every test file passes, including the two new ones (`list-order.test.ts`, `locale-parity.test.ts`).

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Lint the whole project**

Run: `npx eslint .`
Expected: no errors. Warnings that already existed before this branch are acceptable; compare against `git stash`-ed `main` if anything is ambiguous.

- [ ] **Step 4: Confirm the deliberate non-changes**

Run: `git diff main --stat`
Expected: `src/utils/executor-factory.ts` and `__tests__/unit/executor-factory.test.ts` are **absent** from the diff (this feature intentionally bypasses the mutation queue), and `components/ListCard.tsx` is absent (the card itself is unmodified).

- [ ] **Step 5: Confirm the migration will apply**

Run: `grep -c "BIGINT" supabase/migrations/024_list_order.sql && grep -c "ENABLE ROW LEVEL SECURITY" supabase/migrations/024_list_order.sql`
Expected: `1` and `1`. Migrations are applied automatically on deploy by `scripts/migrate.mjs`; no manual step is needed.
