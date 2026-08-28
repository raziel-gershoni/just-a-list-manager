# Archive Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user archive a list off their own home screen and bring it back, without affecting anyone else's view, and stop archived lists from sending them reminders.

**Architecture:** Archive is a per-user view filter, not a state change on the list. `024`'s `list_order` table is renamed to `user_list_state` and gains a nullable `archived_at`, so one per-user table holds both ordering and archive state. `GET /api/lists` filters on it; a new `POST /api/lists/archive` toggles it. Both notification crons gain list-level branches that mirror their existing item-level ones, which also closes a pre-existing leak where deleted lists kept sending reminders for 30 days.

**Tech Stack:** Next.js 16.1.6 (App Router), React 19.2.3, TypeScript, Supabase (postgres-js migrations at build time), `next-intl`, Zod 4, Vitest (node environment, no jsdom), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-08-28-archive-lists-design.md`

## Global Constraints

- **Migrations are append-only** `NNN_snake_case.sql` files in `supabase/migrations/`, applied lexicographically by `scripts/migrate.mjs` at build time with **no surrounding transaction**. Next free number is `025`. Never edit an existing migration.
- **Every new table must `ENABLE ROW LEVEL SECURITY`.** A renamed table keeps its policies, indexes, and constraints — only their names go stale.
- **Tests are `__tests__/**/*.test.ts` only.** `vitest.config.ts:11` does not match `.tsx`, and there is no jsdom. Test pure functions; extract logic out of routes and crons to make it testable.
- **`messages/{en,he,ru}.json` must stay key-for-key identical**, keys added at the same position in all three. Enforced by `__tests__/unit/locale-parity.test.ts`.
- **`app/page.tsx` uses root `useTranslations()` with dotted keys** (`t('lists.archive')`); `components/*.tsx` mostly use `useTranslations('lists')` with bare keys. Match the file you are editing.
- **Archive is per-user.** Never gate it on `verifyListPermission(..., "edit")` — a view-only collaborator must be able to archive. Gate on *visibility* (owner or approved collaborator) instead.
- **Always check `error` from Supabase queries used for authorization.** postgrest-js resolves rather than rejects on failure, so an unchecked error is indistinguishable from an empty result. This exact defect was caught in review on the reorder endpoint.
- **The reminder cron's `.limit(50)`** covers all due, unstamped reminders. Any reminder you decide not to send **must** still be stamped (`sent_at` or `cancelled_at`), or it occupies a slot forever and eventually crowds out real reminders.
- **`npm run build` may fail with `ENVIRONMENT_FALLBACK`** locally (missing env vars during static generation). Pre-existing and unrelated. Verify with `npx tsc --noEmit`, `npx eslint`, and `npx vitest run`.
- **`npx eslint .` reports 6 pre-existing problems** (3 errors, 3 warnings) in `app/login/callback/page.tsx`, `components/TimePicker.tsx`, `components/ReminderSheet.tsx`, `src/hooks/useItemHandlers.ts`. That count must not grow.
- **Do not run anything against `DATABASE_URL`** — it points at production.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/025_user_list_state.sql` (new) | Rename `list_order`, make `position` nullable, add `archived_at` + index, rename the RLS policy |
| `src/utils/list-archive.ts` (new) | Pure: split a list array by archive state for a given view |
| `src/utils/reminder-suppression.ts` (new) | Pure: given list state + archivers, decide send / stamp-sent / cancel and to whom |
| `__tests__/unit/list-archive.test.ts` (new) | Tests for the above |
| `__tests__/unit/reminder-suppression.test.ts` (new) | Tests for the above — highest-risk logic in the change |
| `__tests__/unit/no-list-order-table.test.ts` (new) | Guard: no source file still references the old table name |
| `src/schemas/lists.ts` (modify) | `archiveListSchema` |
| `app/api/lists/archive/route.ts` (new) | Toggle archive state for the calling user |
| `app/api/lists/route.ts` (modify) | Read `archived_at`, filter by view, `?archived=1` |
| `app/api/lists/reorder/route.ts` (modify) | Table rename only |
| `src/hooks/useListData.ts` (modify) | Fall back to `?archived=1` when the list isn't in the default response |
| `app/api/cron/reminders/route.ts` (modify) | List-level suppression branches |
| `app/api/cron/digest/route.ts` (modify) | Drop deleted/archived lists from the digest |
| `src/services/voice-handler.ts` (modify) | Don't offer archived lists as voice targets |
| `components/ListCard.tsx` (modify) | `onArchive` / `onUnarchive` actions |
| `app/page.tsx` (modify) | Active/Archived toggle, per-mode rendering, optimistic archive |
| `messages/{en,he,ru}.json` (modify) | 8 new keys |

---

### Task 1: Migration and table rename

**Files:**
- Create: `supabase/migrations/025_user_list_state.sql`
- Modify: `app/api/lists/route.ts` (the `list_order` query added by the reordering feature), `app/api/lists/reorder/route.ts` (the upsert)
- Test: `__tests__/unit/no-list-order-table.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `user_list_state` table with `position BIGINT NULL` and `archived_at TIMESTAMPTZ NULL`. Used by Tasks 3, 4, 6, 7.

- [ ] **Step 1: Write the guard test**

Create `__tests__/unit/no-list-order-table.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

// Migration 025 renames list_order -> user_list_state. A leftover reference
// compiles fine and fails only at runtime, as a silent empty result from
// PostgREST, so scan for it.
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(full)) acc.push(full);
  }
  return acc;
}

describe("list_order table rename", () => {
  it("no source file queries the old list_order table", () => {
    const root = process.cwd();
    const roots = ["app", "src", "components"].map((d) => resolve(root, d));
    const offenders: string[] = [];

    for (const dir of roots) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        // Matches .from("list_order") and any string literal use of the name.
        if (/["'`]list_order["'`]/.test(text)) {
          offenders.push(file.replace(root + "/", ""));
        }
      }
    }

    expect(
      offenders,
      `these files still reference the renamed table "list_order" (now "user_list_state"): ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/unit/no-list-order-table.test.ts`
Expected: FAIL, listing `app/api/lists/route.ts` and `app/api/lists/reorder/route.ts`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/025_user_list_state.sql`:

```sql
-- Archive is per-user, exactly like list order (024). Fold both into one
-- per-user state table rather than carry two tables keyed (user_id, list_id)
-- that every read would have to join together.
ALTER TABLE list_order RENAME TO user_list_state;

-- A list can be archived without ever having been dragged.
ALTER TABLE user_list_state ALTER COLUMN position DROP NOT NULL;

ALTER TABLE user_list_state ADD COLUMN archived_at TIMESTAMPTZ;

-- The primary key already serves (user_id, list_id) lookups; this serves
-- "which lists has this user archived".
CREATE INDEX IF NOT EXISTS idx_user_list_state_archived
  ON user_list_state(user_id) WHERE archived_at IS NOT NULL;

-- The rename carries RLS, policies, indexes and constraints across; only the
-- policy's name goes stale.
ALTER POLICY "list_order_select_own" ON user_list_state
  RENAME TO "user_list_state_select_own";
```

- [ ] **Step 4: Update the two call sites**

In `app/api/lists/route.ts`, in the `positions` block added by the reordering feature, change `.from("list_order")` to `.from("user_list_state")`.

In `app/api/lists/reorder/route.ts`, change `.from("list_order")` to `.from("user_list_state")`.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app/api/lists/route.ts app/api/lists/reorder/route.ts`
Expected: all tests pass (including the new guard), no tsc output, no eslint output.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/025_user_list_state.sql app/api/lists/route.ts app/api/lists/reorder/route.ts __tests__/unit/no-list-order-table.test.ts
git commit -m "feat: rename list_order to user_list_state and add archived_at"
```

---

### Task 2: Pure archive-filtering helper

**Files:**
- Create: `src/utils/list-archive.ts`
- Test: `__tests__/unit/list-archive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ListView = "active" | "archived"`
  - `filterListsByView<T extends { id: string }>(lists: T[], archivedIds: Set<string>, view: ListView): T[]`

Used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/list-archive.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterListsByView } from "@/src/utils/list-archive";

const lists = [
  { id: "active-1" },
  { id: "archived-1" },
  { id: "active-2" },
  { id: "archived-2" },
];
const archived = new Set(["archived-1", "archived-2"]);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("filterListsByView", () => {
  it("excludes archived lists from the active view", () => {
    expect(ids(filterListsByView(lists, archived, "active"))).toEqual([
      "active-1",
      "active-2",
    ]);
  });

  it("returns only archived lists in the archived view", () => {
    expect(ids(filterListsByView(lists, archived, "archived"))).toEqual([
      "archived-1",
      "archived-2",
    ]);
  });

  it("treats a list with no archive entry as active", () => {
    expect(ids(filterListsByView(lists, new Set(), "active"))).toEqual(
      ids(lists)
    );
  });

  it("returns nothing in the archived view when nothing is archived", () => {
    expect(filterListsByView(lists, new Set(), "archived")).toEqual([]);
  });

  it("preserves input order", () => {
    const reversed = [...lists].reverse();
    expect(ids(filterListsByView(reversed, archived, "active"))).toEqual([
      "active-2",
      "active-1",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = ids(lists);
    filterListsByView(lists, archived, "archived");
    expect(ids(lists)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/unit/list-archive.test.ts`
Expected: FAIL — `Failed to resolve import "@/src/utils/list-archive"`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/list-archive.ts`:

```ts
/**
 * Archive is a per-user view filter, not a state change on the list: a list
 * archived by one collaborator stays active for everyone else. The archived
 * set comes from user_list_state rows with a non-null archived_at.
 */

export type ListView = "active" | "archived";

/** Keep only the lists belonging to the requested view. Input is not mutated. */
export function filterListsByView<T extends { id: string }>(
  lists: T[],
  archivedIds: Set<string>,
  view: ListView
): T[] {
  return lists.filter((list) =>
    view === "archived" ? archivedIds.has(list.id) : !archivedIds.has(list.id)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/unit/list-archive.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/list-archive.ts __tests__/unit/list-archive.test.ts
git commit -m "feat: add pure archive view filter"
```

---

### Task 3: `GET /api/lists` respects archive state

**Files:**
- Modify: `app/api/lists/route.ts` (the `positions` block and the final return in `GET`)
- Modify: `src/hooks/useListData.ts` (fallback fetch)

**Interfaces:**
- Consumes: `filterListsByView` (Task 2), `user_list_state.archived_at` (Task 1).
- Produces: `GET /api/lists` excluding archived lists by default and `GET /api/lists?archived=1` returning only archived ones. Response remains a plain array. Used by Task 10.

- [ ] **Step 1: Add the import**

In `app/api/lists/route.ts`, after the `sortListsByUserOrder` import:

```ts
import { filterListsByView, type ListView } from "@/src/utils/list-archive";
```

- [ ] **Step 2: Read the requested view**

At the top of `GET`, after the auth check:

```ts
  const view: ListView =
    request.nextUrl.searchParams.get("archived") === "1" ? "archived" : "active";
```

- [ ] **Step 3: Collect archived ids alongside positions**

In the `user_list_state` block, extend the select and build the set:

```ts
  const positions = new Map<string, number>();
  const archivedIds = new Set<string>();
  if (listIds.length > 0) {
    const { data: stateRows } = await supabase
      .from("user_list_state")
      .select("list_id, position, archived_at")
      .eq("user_id", auth.userId)
      .in("list_id", listIds);
    for (const row of stateRows || []) {
      // BIGINT arrives from PostgREST as a string.
      if (row.position != null) positions.set(row.list_id, Number(row.position));
      if (row.archived_at) archivedIds.add(row.list_id);
    }
  }
```

Note `position` is now nullable, hence the guard — a list archived without ever being dragged has a row with a null position.

- [ ] **Step 4: Filter before sorting**

Replace the final return of `GET` with:

```ts
  return NextResponse.json(
    sortListsByUserOrder(
      filterListsByView(listsWithCounts, archivedIds, view),
      positions,
      auth.userId
    )
  );
```

- [ ] **Step 5: Make the detail page work for an archived list**

`src/hooks/useListData.ts` fetches the whole `/api/lists` array to find one list's metadata. With archived lists filtered out by default, opening an archived list (via a Telegram deep link, or from the Archived view) would find nothing and render an empty header.

In `src/hooks/useListData.ts`, `fetchItems` currently does (lines 44-58):

```ts
      const listsRes = await fetch("/api/lists", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (listsRes.ok) {
        const allLists = await listsRes.json();
        const currentList = allLists.find((l: { id: string; name: string; is_shared?: boolean; type?: string; icon?: string | null; color?: string | null }) => l.id === listId);
        if (currentList) {
```

Replace that with a version that retries once against the archived view. Keep the inline parameter type exactly as it is; hoist it to a named type first so it is not repeated:

```ts
      type ListSummary = {
        id: string;
        name: string;
        is_shared?: boolean;
        type?: string;
        icon?: string | null;
        color?: string | null;
      };

      const findList = async (url: string): Promise<ListSummary | undefined> => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return undefined;
        const all: ListSummary[] = await res.json();
        return all.find((l) => l.id === listId);
      };

      // The archived view is excluded from the default response, so a list
      // opened from the Archived tab or a Telegram deep link needs a second
      // look. Only on a miss — firing both would double every list open.
      const currentList =
        (await findList("/api/lists")) ??
        (await findList("/api/lists?archived=1"));

      if (currentList) {
```

The body of the `if (currentList) { ... }` block is unchanged. The outer `if (listsRes.ok)` wrapper goes away, since `findList` already handles a non-OK response.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint app/api/lists/route.ts src/hooks/useListData.ts && npx vitest run`
Expected: no tsc or eslint output; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/lists/route.ts src/hooks/useListData.ts
git commit -m "feat: filter GET /api/lists by archive state"
```

---

### Task 4: `POST /api/lists/archive`

**Files:**
- Create: `app/api/lists/archive/route.ts`
- Modify: `src/schemas/lists.ts`

**Interfaces:**
- Consumes: `user_list_state` (Task 1).
- Produces: `POST /api/lists/archive` accepting `{ listId: string, archived: boolean }`, returning `{ archived: boolean }`. Called by Task 10.

- [ ] **Step 1: Add the schema**

Append to `src/schemas/lists.ts`:

```ts
// POST /api/lists/archive
export const archiveListSchema = z.object({
  listId: z.string().uuid(),
  archived: z.boolean(),
});
```

- [ ] **Step 2: Write the route**

Create `app/api/lists/archive/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { archiveListSchema } from "@/src/schemas/lists";
import { parseBody } from "@/src/lib/api-validation";

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-archive");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const parsed = parseBody(archiveListSchema, body);
  if (!parsed.success) return parsed.response;

  const { listId, archived } = parsed.data;
  const supabase = createServerClient();

  // Archive is per-user, so this is NOT verifyListPermission(..., "edit") — a
  // view-only collaborator must be able to archive a shared list off their own
  // home screen. Gate on visibility instead, the same rule GET /api/lists uses.
  const [
    { data: owned, error: ownedError },
    { data: collab, error: collabError },
  ] = await Promise.all([
    supabase
      .from("lists")
      .select("id")
      .eq("id", listId)
      .eq("owner_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("collaborators")
      .select("list_id")
      .eq("list_id", listId)
      .eq("user_id", auth.userId)
      .eq("status", "approved")
      .maybeSingle(),
  ]);

  // postgrest-js resolves rather than rejects on failure, so an unchecked
  // error would read as "this user cannot see the list" and 404 wrongly.
  if (ownedError || collabError) {
    console.error("[lists-archive] Visibility query failed:", ownedError || collabError);
    return NextResponse.json({ error: "Failed to update list" }, { status: 500 });
  }

  if (!owned && !collab) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Only archived_at is supplied, so an existing manual position is preserved.
  const { error } = await supabase.from("user_list_state").upsert(
    {
      user_id: auth.userId,
      list_id: listId,
      archived_at: archived ? new Date().toISOString() : null,
    },
    { onConflict: "user_id,list_id" }
  );

  if (error) {
    console.error("[lists-archive] Upsert failed:", error);
    return NextResponse.json({ error: "Failed to update list" }, { status: 500 });
  }

  return NextResponse.json({ archived });
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint app/api/lists/archive/route.ts src/schemas/lists.ts && npx vitest run`
Expected: no tsc or eslint output; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/api/lists/archive/route.ts src/schemas/lists.ts
git commit -m "feat: add POST /api/lists/archive"
```

---

### Task 5: Pure reminder-suppression helper

**Files:**
- Create: `src/utils/reminder-suppression.ts`
- Test: `__tests__/unit/reminder-suppression.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ReminderAction = { kind: "cancel" } | { kind: "stamp-sent" } | { kind: "send"; recipients: string[] }`
  - `decideReminderDelivery(params: { listDeletedAt: string | null; recipients: string[]; archivedBy: Set<string> }): ReminderAction`

Used by Task 6. This is the highest-risk logic in the change and the crons cannot be run without Supabase, so it is extracted specifically to be testable.

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/reminder-suppression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideReminderDelivery } from "@/src/utils/reminder-suppression";

const DELETED = "2026-08-01T00:00:00.000Z";

describe("decideReminderDelivery", () => {
  it("cancels when the list is soft-deleted", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("cancels a deleted list even when nobody archived it", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("sends to everyone when nobody archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "send", recipients: ["u1", "u2"] });
  });

  it("drops only the recipients who archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1", "u2", "u3"],
        archivedBy: new Set(["u2"]),
      })
    ).toEqual({ kind: "send", recipients: ["u1", "u3"] });
  });

  // Must be stamp-sent, not cancel: unarchiving should not resurrect a
  // past-due reminder, but the row must leave the cron's .limit(50) window or
  // it occupies a slot forever and eventually crowds out real reminders.
  it("stamps sent when every recipient archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1", "u2"],
        archivedBy: new Set(["u1", "u2"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent for a personal reminder whose creator archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent when there are no recipients at all", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: [],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("prefers cancel over stamp-sent when the list is both deleted and archived", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "cancel" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/unit/reminder-suppression.test.ts`
Expected: FAIL — `Failed to resolve import "@/src/utils/reminder-suppression"`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/reminder-suppression.ts`:

```ts
/**
 * Whether a due reminder should actually be delivered, and to whom.
 *
 * Two rules beyond the item-level ones the cron already applies:
 *
 * - The list is soft-deleted -> cancel. Deleting a list did NOT previously stop
 *   its reminders, so they kept firing for the 30 days until the purge cron
 *   hard-deleted the list.
 * - A recipient archived the list -> don't notify that person. Archive is
 *   per-user, so other collaborators still get theirs.
 *
 * Anything not delivered must still be STAMPED. The cron selects due, unstamped
 * reminders with .limit(50); an unstamped reminder that is never sent occupies
 * a slot forever and eventually starves real ones. "stamp-sent" rather than
 * "cancel" for the archived case, because cancelling is the harsher, item-
 * deleted semantic — though note that unarchiving does not resurrect a
 * past-due reminder either way.
 */

export type ReminderAction =
  | { kind: "cancel" }
  | { kind: "stamp-sent" }
  | { kind: "send"; recipients: string[] };

export function decideReminderDelivery({
  listDeletedAt,
  recipients,
  archivedBy,
}: {
  listDeletedAt: string | null;
  recipients: string[];
  archivedBy: Set<string>;
}): ReminderAction {
  if (listDeletedAt) return { kind: "cancel" };

  const live = recipients.filter((userId) => !archivedBy.has(userId));
  if (live.length === 0) return { kind: "stamp-sent" };

  return { kind: "send", recipients: live };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/unit/reminder-suppression.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/reminder-suppression.ts __tests__/unit/reminder-suppression.test.ts
git commit -m "feat: add pure reminder suppression decision"
```

---

### Task 6: Wire suppression into both crons

**Files:**
- Modify: `app/api/cron/reminders/route.ts`
- Modify: `app/api/cron/digest/route.ts`

**Interfaces:**
- Consumes: `decideReminderDelivery` (Task 5), `user_list_state` (Task 1).
- Produces: archived lists stop notifying the user who archived them; deleted lists stop notifying anyone.

- [ ] **Step 1: Select the list's deleted state in the reminders cron**

In `app/api/cron/reminders/route.ts`, change the joined list select from `lists!inner(name)` to `lists!inner(name, deleted_at)`, and widen the cast in the loop from `{ name: string }` to `{ name: string; deleted_at: string | null }`.

- [ ] **Step 2: Add the import**

```ts
import { decideReminderDelivery } from "@/src/utils/reminder-suppression";
```

- [ ] **Step 3: Apply the decision**

The loop currently resolves recipients *inside* each branch: the `is_shared` branch builds `memberIds` (owner + approved collaborators) and sends in the same loop, while the `else` branch sends straight to `creator`. Restructure so recipients are resolved **first**, the decision is applied, and only then does sending happen.

Replace the whole `if (reminder.is_shared) { ... } else { ... }` block with:

```ts
      // Resolve recipients before deciding anything, so both shapes go through
      // the same suppression check.
      const recipients: string[] = [];
      if (reminder.is_shared) {
        const { data: listData } = await supabase
          .from("lists")
          .select("owner_id")
          .eq("id", reminder.list_id)
          .single();
        if (listData) recipients.push(listData.owner_id);

        const { data: collabs } = await supabase
          .from("collaborators")
          .select("user_id")
          .eq("list_id", reminder.list_id)
          .eq("status", "approved");
        for (const c of collabs || []) {
          if (!recipients.includes(c.user_id)) recipients.push(c.user_id);
        }
      } else {
        recipients.push(reminder.created_by);
      }
```

then the decision block below, and finally the send loop:

```ts
      for (const recipientId of decision.recipients) {
        const { data: member } = await supabase
          .from("users")
          .select("telegram_id, language")
          .eq("id", recipientId)
          .single();

        if (!member?.telegram_id) continue;
        try {
          await sendItemReminder(
            member.telegram_id,
            member.language || "en",
            item.text,
            list.name,
            reminder.list_id,
            reminder.id,
            recipientId !== reminder.created_by ? creator.name : undefined
          );
        } catch (e) {
          console.error("[Cron/Reminders] Failed to send to:", recipientId, e);
        }
      }
```

This unifies the two branches: the personal case is just a single-recipient list, and `recipientId !== reminder.created_by` is already false for it, so no "shared by" attribution is added — matching today's behaviour exactly.

Insert the decision between those two blocks:

```ts
      // Which of these recipients archived this list? Archive is per-user.
      const { data: archivedRows } = await supabase
        .from("user_list_state")
        .select("user_id")
        .eq("list_id", reminder.list_id)
        .not("archived_at", "is", null)
        .in("user_id", recipients);

      const decision = decideReminderDelivery({
        listDeletedAt: list.deleted_at,
        recipients,
        archivedBy: new Set((archivedRows || []).map((r) => r.user_id)),
      });

      if (decision.kind === "cancel") {
        await supabase
          .from("item_reminders")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }

      if (decision.kind === "stamp-sent") {
        await supabase
          .from("item_reminders")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }
```

Then send only to `decision.recipients` instead of the full recipient list. Restructure the existing code so both the personal and shared paths build a `recipients: string[]` first — the personal path is simply `[reminder.created_by]` — and the send loop iterates `decision.recipients`. Keep the existing per-recipient message construction untouched.

- [ ] **Step 4: Filter the digest**

In `app/api/cron/digest/route.ts`, change the per-user reminder select at `route.ts:54-63` from `lists!inner(name)` to `lists!inner(id, name, deleted_at)`.

Inside the same per-user loop, before the existing `liveReminders` filter, fetch this user's archived list ids once:

```ts
      const { data: archivedRows } = await supabase
        .from("user_list_state")
        .select("list_id")
        .eq("user_id", userId)
        .not("archived_at", "is", null);
      const archivedListIds = new Set((archivedRows || []).map((r) => r.list_id));
```

Then extend the existing filter (`route.ts:66-69`) to also drop deleted and archived lists:

```ts
      const liveReminders = (reminders || []).filter((r) => {
        const item = r.items as unknown as { completed: boolean; deleted_at: string | null };
        const list = r.lists as unknown as { id: string; deleted_at: string | null };
        return (
          !item.completed &&
          !item.deleted_at &&
          !list.deleted_at &&
          !archivedListIds.has(list.id)
        );
      });
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx eslint app/api/cron/reminders/route.ts app/api/cron/digest/route.ts && npx vitest run`
Expected: no tsc or eslint output; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/reminders/route.ts app/api/cron/digest/route.ts
git commit -m "fix: stop reminders for archived and deleted lists"
```

---

### Task 7: Voice handler skips archived lists

**Files:**
- Modify: `src/services/voice-handler.ts` (the list enumeration around lines 105-134)

**Interfaces:**
- Consumes: `user_list_state` (Task 1).
- Produces: archived list names never reach Gemini as candidate targets.

- [ ] **Step 1: Fetch the speaker's archived list ids**

In `src/services/voice-handler.ts`, immediately after `uniqueLists` is built (around line 133), add:

```ts
    // Archive is per-user: a list this speaker archived should not be a target
    // for "add milk to X".
    const { data: archivedRows } = await supabase
      .from("user_list_state")
      .select("list_id")
      .eq("user_id", user.id)
      .not("archived_at", "is", null);
    const archivedListIds = new Set((archivedRows || []).map((r) => r.list_id));
    const selectableLists = uniqueLists.filter((l) => !archivedListIds.has(l.id));
```

- [ ] **Step 2: Use the filtered set**

Replace subsequent uses of `uniqueLists` in this function with `selectableLists` — including the `uniqueLists.length === 0` "no lists" branch and the single-list default. Note this makes the single-list default more likely to fire as lists get archived, which is intended.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint src/services/voice-handler.ts && npx vitest run`
Expected: no tsc or eslint output; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/voice-handler.ts
git commit -m "feat: exclude archived lists from voice targets"
```

---

### Task 8: i18n keys

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (the `lists` namespace, after `reorderFailed`)

**Interfaces:**
- Produces: 8 keys used by Tasks 9 and 10.

- [ ] **Step 1: Add all 8 keys to all three files at the same position**

`messages/en.json`, after `"reorderFailed"`:

```json
    "active": "Active",
    "archived": "Archived",
    "archive": "Archive",
    "unarchive": "Unarchive",
    "listArchived": "List archived",
    "listUnarchived": "List unarchived",
    "archiveFailed": "Couldn't archive the list",
    "emptyArchived": "No archived lists"
```

`messages/he.json`, same position:

```json
    "active": "פעילות",
    "archived": "בארכיון",
    "archive": "העבר לארכיון",
    "unarchive": "הוצא מהארכיון",
    "listArchived": "הרשימה הועברה לארכיון",
    "listUnarchived": "הרשימה הוצאה מהארכיון",
    "archiveFailed": "לא הצלחנו להעביר את הרשימה לארכיון",
    "emptyArchived": "אין רשימות בארכיון"
```

`messages/ru.json`, same position:

```json
    "active": "Активные",
    "archived": "В архиве",
    "archive": "В архив",
    "unarchive": "Из архива",
    "listArchived": "Список отправлен в архив",
    "listUnarchived": "Список возвращён из архива",
    "archiveFailed": "Не удалось отправить список в архив",
    "emptyArchived": "Нет списков в архиве"
```

- [ ] **Step 2: Verify parity**

Run: `npx vitest run __tests__/unit/locale-parity.test.ts`
Expected: PASS, 2 tests. A failure names exactly which keys are missing from which file.

- [ ] **Step 3: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json
git commit -m "feat: add archive i18n strings"
```

---

### Task 9: `ListCard` archive actions

**Files:**
- Modify: `components/ListCard.tsx`

**Interfaces:**
- Consumes: `lists.archive` / `lists.unarchive` (Task 8).
- Produces: `ListCard` accepting optional `onArchive?: () => void` and `onUnarchive?: () => void`. Used by Task 10.

- [ ] **Step 1: Add the props and icons**

In `components/ListCard.tsx`, add to `ListCardProps`:

```ts
  onArchive?: () => void;
  onUnarchive?: () => void;
```

Destructure them in the component signature, and add `Archive` and `ArchiveRestore` to the existing `lucide-react` import.

- [ ] **Step 2: Render the actions**

In the trailing action row (the `<div className="flex items-center gap-2">` that holds edit and delete), add the archive action **before** the edit action, and the unarchive action in its place. Use the same `<span role="button">` pattern the existing actions use — the root is a `<button>`, so a nested `<button>` would be invalid HTML:

```tsx
        {onArchive && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="p-2 rounded-full active:bg-tg-secondary-bg transition-colors"
            title={t('archive')}
          >
            <Archive className="w-4 h-4 text-tg-hint" />
          </span>
        )}
        {onUnarchive && (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onUnarchive(); }}
            className="p-2 rounded-full active:bg-tg-secondary-bg transition-colors"
            title={t('unarchive')}
          >
            <ArchiveRestore className="w-4 h-4 text-tg-hint" />
          </span>
        )}
```

`ListCard` uses `useTranslations('lists')`, so the keys are bare.

- [ ] **Step 3: Pass the props through `SortableListCard`**

`components/SortableListCard.tsx` re-declares every `ListCard` prop explicitly. Add `onArchive?: () => void` to its props interface, destructure it, and pass it to the rendered `ListCard`. `onUnarchive` is **not** needed there — the archived view does not render sortable cards.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint components/ListCard.tsx components/SortableListCard.tsx && npx vitest run`
Expected: no tsc or eslint output; all tests pass (including the `handleRef` guard).

- [ ] **Step 5: Commit**

```bash
git add components/ListCard.tsx components/SortableListCard.tsx
git commit -m "feat: add archive and unarchive actions to ListCard"
```

---

### Task 10: Home screen Active/Archived toggle

**Files:**
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: the finished feature.

- [ ] **Step 1: Add view state**

Alongside the other `useState` calls:

```tsx
  const [view, setView] = useState<"active" | "archived">("active");
```

- [ ] **Step 2: Make `fetchLists` view-aware**

`fetchLists` currently takes `{ silent }`. Add the view to its request and its dependencies:

```tsx
      const res = await fetch(
        view === "archived" ? "/api/lists?archived=1" : "/api/lists",
        { headers: { Authorization: `Bearer ${jwt}` } }
      );
```

Add `view` to the `useCallback` dependency array. The existing `useEffect` that calls `fetchLists` when `isReady` flips will now also refetch on every view change, because `fetchLists` is in its dependency array.

**Important:** the auto-open-single-list redirect inside `fetchLists` must not fire in the archived view — opening the Archived tab with exactly one archived list would navigate away from it. Guard that block with `view === "active"`.

- [ ] **Step 3: Render the toggle**

Directly below the `<h1>` at `app/page.tsx:387`, inside the header, add a two-segment control. Reuse the existing token palette rather than introducing new colours:

```tsx
        <div className="flex items-center gap-1 mt-3 p-1 rounded-xl bg-tg-secondary-bg">
          {(["active", "archived"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                view === mode
                  ? "bg-tg-button text-tg-button-text"
                  : "text-tg-hint"
              }`}
            >
              {t(`lists.${mode}`)}
            </button>
          ))}
        </div>
```

The header is currently a flex row containing the `<h1>` and the language/logout buttons. Place the toggle so it sits on its own line under both — restructure the header into a column wrapper if needed rather than squeezing it into the existing row.

- [ ] **Step 4: Add the archive handler**

```tsx
  const handleSetArchived = useCallback(
    (list: ListData, archived: boolean) => {
      const jwt = jwtRef.current;
      if (!jwt) return;

      const snapshot = lists;
      const index = lists.findIndex((l) => l.id === list.id);
      setLists((prev) => prev.filter((l) => l.id !== list.id));

      const undo = () => {
        setLists((prev) => {
          const next = [...prev];
          next.splice(index === -1 ? next.length : index, 0, list);
          return next;
        });
        void fetch("/api/lists/archive", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwtRef.current}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ listId: list.id, archived: !archived }),
        });
      };

      setToast((prev) => {
        if (prev) clearTimeout(prev.timeout);
        return {
          message: t(archived ? 'lists.listArchived' : 'lists.listUnarchived'),
          undo: () => {
            setToast(null);
            undo();
          },
          timeout: setTimeout(() => setToast(null), 4000),
        };
      });

      fetch("/api/lists/archive", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ listId: list.id, archived }),
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
        })
        .catch((e) => {
          console.error("[Home] Archive error:", e);
          setLists(snapshot);
          setToast((prev) => {
            if (prev) clearTimeout(prev.timeout);
            return {
              message: t('lists.archiveFailed'),
              timeout: setTimeout(() => setToast(null), 4000),
            };
          });
          // silent: a failure must never swap in the full-page error view
          fetchLists({ silent: true });
        });
    },
    [lists, jwtRef, t, fetchLists]
  );
```

Note the undo path clears the toast before restoring, matching how the delete undo behaves.

- [ ] **Step 5: Render per view**

Replace the card map so the archived view renders plain `ListCard`s with no drag provider — mirroring how the item screen simply does not wrap non-draggable sections:

```tsx
      <div className="flex-1 px-5 pt-3 pb-24 space-y-3">
        {view === "archived" ? (
          lists.map((list) => (
            <ListCard
              key={list.id}
              id={list.id}
              name={list.name}
              type={list.type}
              icon={list.icon}
              color={list.color}
              activeCount={list.active_count}
              completedCount={list.completed_count}
              isShared={list.is_shared}
              role={list.role}
              onClick={() => router.push(`/list/${list.id}`)}
              onUnarchive={() => handleSetArchived(list, false)}
            />
          ))
        ) : (
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
                  if (shouldSuppressClick()) return;
                  router.push(`/list/${list.id}`);
                }}
                onArchive={() => handleSetArchived(list, true)}
                onEdit={list.role === "owner" ? () => handleEditList(list) : undefined}
                onDelete={list.role === "owner" ? () => handleDeleteList(list) : undefined}
              />
            ))}
          </DragDropProvider>
        )}
      </div>
```

Re-add the `ListCard` import, which Task 7 of the reordering plan removed.

- [ ] **Step 6: Handle the empty archived view**

The `lists.length === 0` branch currently renders the first-run `EmptyState` with a "create your first list" call to action, which is wrong for an empty archive. Guard it:

```tsx
  if (lists.length === 0 && view === "archived") {
    // header + toggle + a short message, no create-list call to action
  }
```

Render the same header and toggle (so the user can switch back), and `t('lists.emptyArchived')` centred in the body. Keep the existing `EmptyState` for `view === "active"`.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx eslint app/page.tsx && npx vitest run`
Expected: no tsc or eslint output; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add Active/Archived toggle to the home screen"
```

---

### Task 11: Full verification

**Files:** none modified.

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: every file passes, including `list-archive.test.ts`, `reminder-suppression.test.ts`, `no-list-order-table.test.ts`, and the pre-existing `list-order.test.ts` and `locale-parity.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Lint**

Run: `npx eslint .`
Expected: exactly the 6 pre-existing problems (3 errors, 3 warnings), no more. Compare against `main` if unsure.

- [ ] **Step 4: Confirm the rename is complete**

Run: `grep -rn "list_order" app src components supabase --include=*.ts --include=*.tsx --include=*.sql`
Expected: hits **only** in `supabase/migrations/024_list_order.sql` (the original, never edited) and `supabase/migrations/025_user_list_state.sql` (the `ALTER TABLE ... RENAME`). No `.ts`/`.tsx` hits.

- [ ] **Step 5: Confirm no reminder can be dropped without being stamped**

Run: `grep -n "decideReminderDelivery" -A 20 app/api/cron/reminders/route.ts`
Expected: every branch of the returned action either sends, stamps `sent_at`, or stamps `cancelled_at` before `continue`. A `continue` with no update is the bug this step exists to catch.
