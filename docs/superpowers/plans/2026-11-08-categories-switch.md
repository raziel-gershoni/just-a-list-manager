# Grocery categories switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-list "Sort into categories" switch on grocery lists. Off deletes all of the list's categorization; on starts sorting from zero.

**Architecture:**
- A `lists.categories_enabled` column, set through one database function that does the
  off-cleanup in the same transaction.
- The categorizer's two write functions check the switch under the same list row lock, so a sort
  already running can't leave anything behind.
- The categorizer, the GET sweep and the client grouping all gate on the switch. Realtime carries
  it to collaborators.

**Tech Stack:** Next.js 16 route handlers, Supabase (PostgREST + plpgsql), React 19, next-intl, vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-categories-switch-design.md`

## Global Constraints

- **NEVER run `npm run build`:** it migrates prod. The gate is
  `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit && npx next build`.
- **No database or network contact from tests.** Mock Supabase with `__tests__/helpers/fake-supabase.ts`.
  Never read `.env*`.
- **Commits:**
  - Implementers only run `git add` and `git commit`. They never push, branch, rebase or amend.
  - Every commit message ends with:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_016BJjXEtKiBjZzPxUBk941y
    ```
- **Logging:**
  - Every caught error is logged, with no empty catches.
  - Never log tokens, item text or list names. List ids are fine.
- **Strings:** no inline user-facing strings. Copy lives in `messages/{en,he,ru}.json`, and
  `locale-parity.test.ts` must stay green.
- **Column and RPC names, verbatim:**
  - `categories_enabled` (DB column)
  - `categoriesEnabled` (API body and client state)
  - `set_list_categories_enabled(p_list_id UUID, p_enabled BOOLEAN)`
  - `sortsIntoCategories(list)`
  - `clearItemCategories(items)`
  - `clearCategorization()`
  - `setCategoriesEnabled`
- **Copy:**
  - `categories.enabled`: en "Sort into categories", he "מיון לפי קטגוריות", ru "Сортировка по категориям"
  - `categories.confirmOff`:
    - en "Turn off sorting? The list's categories and their order will be deleted."
    - he "לכבות את המיון? הקטגוריות של הרשימה והסדר שלהן יימחקו."
    - ru "Отключить сортировку? Категории списка и их порядок будут удалены."
- **Tests must bite.** Every new guard gets a test that you have seen fail with the guard removed.

## Review Focus

1. **An "on" for a list that is already on** (a second tap, or a stale device) must not delete anything.
   `set_list_categories_enabled(true)` only sets the flag. Pinned in Task 1 (SQL check) and Task 3
   (the route sends `p_enabled: true`, with no cleanup path).
2. **A sort in the middle of its AI call when the owner turns off** must leave no categories behind.
   Pinned in Task 1 (both write functions refuse while off) and Task 2 (`runOnce` stops before the AI
   when the switch went off after the entry gate).
3. **Old fakes and old servers that have no `categories_enabled` field:**
   - The server rule is strict (`=== true`), so an unknown switch never spends AI. Pinned in Task 2.
   - The client reads `categories_enabled !== false`, so a server still deploying the old code opens
     lists grouped as before. Pinned in Task 4.
4. **An item still carrying a deleted category after off, then on** would stay under "Sorting…"
   forever, because `retrySorting` only fills items with no `category_id`. `clearCategorization()`
   prevents it. Pinned in Task 4 (realtime off clears) and Task 5 (local off clears before the save).
5. **A failed off** must give the categories back on screen (`loadCategories()`), not leave an empty
   grouped list. Pinned in Task 5.

---

### Task 1: Migration 032 (switch column, switch function, gated write functions)

**Files:**
- Create: `supabase/migrations/032_list_categories_enabled.sql`
- Scratch only, never committed: `$SCRATCH/catoff/sql/` (PGlite check script). `$SCRATCH` is the
  scratchpad directory the controller gives you.

**Interfaces:**
- Produces:
  - Column `lists.categories_enabled BOOLEAN NOT NULL DEFAULT true`.
  - RPC `set_list_categories_enabled(p_list_id UUID, p_enabled BOOLEAN) RETURNS SETOF lists`.
  - `insert_list_category` and `apply_item_categories` keep their signatures and refuse while the
    switch is off.

- [ ] **Step 1: Write the migration**

```sql
-- A per-list switch for grocery categories (docs/superpowers/specs/2026-11-08-categories-switch-design.md).
-- Off deletes the list's categories and every item's placement; on starts sorting from zero.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS categories_enabled BOOLEAN NOT NULL DEFAULT true;

-- The switch and its cleanup in one transaction. The list row is updated first, so this holds the
-- row lock the categorizer's writes check the switch under: a write either lands before the
-- cleanup, which then removes it, or waits and sees the switch off. Categories are deleted before
-- the items are touched, the order a category delete takes, so the two cannot deadlock.
-- On only sets the flag: a repeated "on" must never wipe a list that is sorted.
CREATE OR REPLACE FUNCTION set_list_categories_enabled(p_list_id UUID, p_enabled BOOLEAN)
RETURNS SETOF lists AS $$
BEGIN
  UPDATE lists
  SET categories_enabled = p_enabled,
      categories_rescan_at = CASE WHEN p_enabled THEN categories_rescan_at ELSE NULL END
  WHERE id = p_list_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT p_enabled THEN
    -- ON DELETE SET NULL clears the items' category_id; the update then unlocks hand placements.
    DELETE FROM list_categories WHERE list_id = p_list_id;
    UPDATE items SET category_id = NULL, category_locked = false
    WHERE list_id = p_list_id AND (category_id IS NOT NULL OR category_locked);
  END IF;
  RETURN QUERY SELECT * FROM lists WHERE id = p_list_id;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION set_list_categories_enabled(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_list_categories_enabled(UUID, BOOLEAN) TO service_role;
```

Then re-create both write functions. Copy their full bodies from
`supabase/migrations/027_list_categories.sql`, with exactly these changes.

**`apply_item_categories`:** insert at the top of `BEGIN`:

```sql
  -- Categories turned off: write nothing. FOR SHARE waits for a cleanup holding the list row and
  -- then reads its result, and holds a cleanup back until this write is done.
  PERFORM 1 FROM lists WHERE id = p_list_id AND categories_enabled FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
```

**`insert_list_category`:** replace `PERFORM 1 FROM lists WHERE id = p_list_id FOR UPDATE;` with:

```sql
  -- The same lock as before; a list with categories off gets no new category.
  PERFORM 1 FROM lists WHERE id = p_list_id AND categories_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
```

Also update its header comment: "Returns no row when the list already has p_max categories, or its
categories are off."

`CREATE OR REPLACE` keeps the existing grants, so don't re-issue them for these two.

- [ ] **Step 2: Check the SQL on in-memory PGlite (scratch only)**

```bash
mkdir -p "$SCRATCH/catoff/sql" && cd "$SCRATCH/catoff/sql" && npm init -y >/dev/null && npm i @electric-sql/pglite >/dev/null
```

Write `check.mjs` in that directory. It creates a minimal schema:
- Roles `anon`, `authenticated`, `service_role`.
- `users(id uuid pk)`.
- `lists`, with `id, owner_id, name, type, deleted_at, categories_rescan_at, updated_at`, plus
  `update_updated_at()` and the 027 trigger.
- `list_categories` (as in 027).
- `items`, with `id, list_id, text, completed, deleted_at, created_at, category_id` (FK
  `ON DELETE SET NULL`) and `category_locked`.

It then runs the 027 function bodies, then `032_list_categories_enabled.sql` read from the repo, and
asserts each of these, printing PASS or FAIL per case:
1. `set_list_categories_enabled(L, false)`:
   - It deletes every `list_categories` row of L. Another list's rows stay.
   - Every item of L ends with `category_id IS NULL AND category_locked = false`, including completed,
     soft-deleted and hand-locked items.
   - It clears `categories_rescan_at`.
   - It returns one row with `categories_enabled = false`.
2. On a sorted list (categories present, items placed, a locked item),
   `set_list_categories_enabled(L, true)`:
   - Categories and placements are unchanged.
   - `categories_rescan_at` is unchanged.
   - It returns one row with `categories_enabled = true`.
3. While L is off:
   - `insert_list_category(L, …, 'last', NULL, 20)` returns no row and inserts nothing.
   - `apply_item_categories(L, '[…]', false)` returns 0 and changes nothing.
4. While L is on, both work as before: one row inserted, and the count of applied items.
5. On a soft-deleted list (`deleted_at` set), `set_list_categories_enabled(L, false)` returns no row and
   deletes nothing.
6. A new list gets `categories_enabled = true` by default.

Run: `node check.mjs`
Expected: all PASS. Then **bite**:
- Comment out the `DELETE` in a scratch copy of the migration: case 1 must FAIL.
- Comment out the new `IF NOT FOUND THEN RETURN 0` guard: case 3 must FAIL.
- Comment out the new `IF NOT FOUND THEN RETURN` guard in `insert_list_category`: case 3 must FAIL.

Keep these copies in scratch only.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/032_list_categories_enabled.sql
git commit -m "feat(db): a per-list switch for grocery categories; off cleans up in one transaction

<trailers>"
```

---

### Task 2: Categorizer and GET sweep obey the switch

**Files:**
- Create: `src/utils/categories-switch.ts`
- Modify: `src/services/categorize-list.ts`:
  - The entry gate (about lines 243-256).
  - The `runOnce` list read (about lines 72-80).
  - The insert-no-row comment (about line 182).
- Modify: `app/api/lists/[id]/items/route.ts`: the GET list read and the sweep condition (about lines
  91-112).
- Modify: `app/api/lists/[id]/categories/route.ts`: the no-row 400 message (about line 74).
- Test: `__tests__/unit/categorize-list.test.ts`, `__tests__/unit/items-route-categorize.test.ts`,
  `__tests__/unit/categories-routes.test.ts`, plus any fixture the full suite shows needs
  `categories_enabled: true` (for example `items-route-db-errors.test.ts:65`).

**Interfaces:**
- Consumes: the Task 1 column. The categorizer test fakes model it, so nothing here touches a DB.
- Produces:
  `export function sortsIntoCategories(list: { type?: string | null; categories_enabled?: boolean | null } | null | undefined): boolean`

- [ ] **Step 1: Write the failing tests**

In `categorize-list.test.ts`, extend `world()`:
- Add an option `enabled?: boolean | boolean[]` (default `true`). An array answers successive `lists`
  select reads: the entry gate first, then each `runOnce` read.
- Store it on `list` as `categories_enabled`.
- Change the `failListRead` line to match the entry gate's new select:
  `call.cols === "type, categories_enabled"`.
- Implement the array by keeping a read counter for `lists` selects, and returning
  `{ ...list, categories_enabled: answers[n] ?? answers[answers.length - 1] }`.

Add to `describe("categorizeList")`:

```ts
  it("does nothing for a grocery list with categories off", async () => {
    const w = world({ enabled: false, items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.lock.acquire).not.toHaveBeenCalled();
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.fake.calls.find((c) => c.table === "lists" && c.op === "select")!.cols).toContain("categories_enabled");
  });

  it("stops before the AI when categories were turned off after it started", async () => {
    // On at the entry gate, off by the time the round reads the list under the lock.
    const w = world({ enabled: [true, false], items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.lock.acquire).toHaveBeenCalledTimes(1);
    expect(w.lock.released).toHaveLength(1);
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.inserts()).toEqual([]);
    expect(w.rpc()).toEqual([]);
  });

  it("stops a rerun once categories are off", async () => {
    // The first round sorts; categories go off before the rerun reads the list.
    const w = world({
      enabled: [true, true, false],
      reruns: ["pending"],
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "old", text: "Milk", category_id: "dairy" }), row({ id: "new", text: "milk" })],
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.rpc()).toHaveLength(1);
    expect(w.lock.acquire).toHaveBeenCalledTimes(2);
  });

  it("logs and stops the round when the list cannot be read under the lock", async () => {
    // The entry gate reads fine; the round's read fails.
    const w = world({ failRoundRead: true, items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.rpc()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "[Categorizer] could not read the list",
      expect.objectContaining({ listId: "L", error: expect.objectContaining({ message: "fetch failed" }) })
    );
  });
```

`failRoundRead` is a new `world()` option. It makes the `lists` select whose cols are
`"type, categories_enabled, categories_rescan_at"` answer `{ data: null, error: dbError }`.

Add a pure test file `__tests__/unit/categories-switch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortsIntoCategories } from "@/src/utils/categories-switch";

describe("sortsIntoCategories", () => {
  it.each([
    [{ type: "grocery", categories_enabled: true }, true],
    [{ type: "grocery", categories_enabled: false }, false],
    // Unknown is not on: a read that left the column out must never spend AI.
    [{ type: "grocery" }, false],
    [{ type: "grocery", categories_enabled: null }, false],
    [{ type: "regular", categories_enabled: true }, false],
    [null, false],
    [undefined, false],
  ])("%j → %s", (list, expected) => {
    expect(sortsIntoCategories(list)).toBe(expected);
  });
});
```

In `items-route-categorize.test.ts`:
- Widen `listed()`'s `list` type with `categories_enabled?: boolean`.
- Change `const grocery = { type: "grocery", categories_rescan_at: null, categories_enabled: true };`.
- Add these tests:

```ts
  it("GET on a grocery list with categories off schedules nothing, though none of its items has a category", async () => {
    listed([{ id: "a", position: 1, category_id: null }], { ...grocery, categories_enabled: false });
    await GET(req("GET"), params);
    expect(h.after).toEqual([]);
  });

  it("GET with categories off ignores an owed re-scan", async () => {
    listed([{ id: "a", position: 1, category_id: "x" }], { ...grocery, categories_enabled: false, categories_rescan_at: "2026-11-08T10:00:00Z" });
    await GET(req("GET"), params);
    expect(h.after).toEqual([]);
  });

  it("GET reads the switch with the list's type", async () => {
    listed([{ id: "a", position: 1, category_id: null }], grocery);
    await GET(req("GET"), params);
    const read = h.fake.calls.find((c) => c.table === "lists") as { cols?: string };
    expect(read.cols).toContain("categories_enabled");
  });
```

In `categories-routes.test.ts`, in the test "refuses a 21st category", also assert the message names
both causes:

```ts
    expect((await res.json()).error).toMatch(/categories are off/);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run __tests__/unit/categorize-list.test.ts __tests__/unit/categories-switch.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/categories-routes.test.ts`
Expected: the new cases FAIL (module missing, AI called, sweep scheduled, message mismatch).

- [ ] **Step 3: Implement**

`src/utils/categories-switch.ts`:

```ts
// The one rule for whether a list's items are sorted into categories (the per-list switch,
// docs/superpowers/specs/2026-11-08-categories-switch-design.md).

/** A grocery list with its categories switch on. Unknown is not on: it must never spend AI. */
export function sortsIntoCategories(
  list: { type?: string | null; categories_enabled?: boolean | null } | null | undefined
): boolean {
  return list?.type === "grocery" && list.categories_enabled === true;
}
```

`categorize-list.ts` entry gate:

```ts
    const { data: list, error } = await full.supabase
      .from("lists")
      .select("type, categories_enabled")
      .eq("id", listId)
      .is("deleted_at", null)
      .maybeSingle();
    // A failed read is not "not a grocery list": log it. The next trigger or GET sweep retries.
    if (error) {
      console.error("[Categorizer] could not read the list type", { listId, mode, error });
      return;
    }
    // Not a grocery list, or its categories are switched off.
    if (!sortsIntoCategories(list as Parameters<typeof sortsIntoCategories>[0])) return;
```

`runOnce` read, replacing the existing `categories_rescan_at` read and its error log:

```ts
  // Read under the lock: the switch may have gone off since the entry gate (then nothing is
  // sorted or written), and a re-scan the user asked for stays owed until one gets an AI
  // answer, so every run re-scans until then.
  const { data: listData, error: listError } = await supabase
    .from("lists")
    .select("type, categories_enabled, categories_rescan_at")
    .eq("id", listId)
    .maybeSingle();
  if (listError) {
    // An unknown switch is not "on": the next trigger, GET sweep or client retry runs it.
    console.error("[Categorizer] could not read the list", { listId, error: listError });
    return;
  }
  const listRow = listData as { type?: string; categories_enabled?: boolean; categories_rescan_at?: string | null } | null;
  if (!sortsIntoCategories(listRow)) return;
  const owed = listRow?.categories_rescan_at ?? null;
```

Leave the rest of `runOnce` as it is.

The insert-no-row comment becomes:
`// No row: the list reached the cap meanwhile, or its categories were turned off. Its items stay uncategorized.`

Items GET, in `app/api/lists/[id]/items/route.ts`:
- The read becomes `supabase.from("lists").select("type, categories_enabled, categories_rescan_at")`.
- The sweep condition becomes:

```ts
  // Sweep grocery lists with categories on: first scan after deploy, failed runs, and a re-scan still owed.
  if (
    sortsIntoCategories(list) &&
    (list?.categories_rescan_at || (items || []).some((i) => !i.category_id))
  ) {
```

Category POST no-row answer (`app/api/lists/[id]/categories/route.ts`):

```ts
  if (!category) {
    // The insert runs under the list lock: at the cap, or the list's categories were turned off.
    return NextResponse.json({ error: "Category not added: the list is at 20 categories or its categories are off" }, { status: 400 });
  }
```

Leave the pre-check's own "A list can have at most 20 categories" message as it is.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Fix any fixture that now needs `categories_enabled: true` to keep its sweep. Change
only the fixture, never the assertion.

- [ ] **Step 5: Bite**
- Revert the entry-gate rule to `type !== "grocery"`: "does nothing for a grocery list with categories
  off" must FAIL.
- Remove the `runOnce` `sortsIntoCategories` return: "stops before the AI…" must FAIL.
- Replace `sortsIntoCategories(list)` in the sweep with `list?.type === "grocery"`: the two sweep
  tests must FAIL.

Restore each change after checking.

- [ ] **Step 6: Commit**

```bash
git add src/utils/categories-switch.ts src/services/categorize-list.ts "app/api/lists/[id]/items/route.ts" "app/api/lists/[id]/categories/route.ts" __tests__/unit/categorize-list.test.ts __tests__/unit/categories-switch.test.ts __tests__/unit/items-route-categorize.test.ts __tests__/unit/categories-routes.test.ts
# plus any fixture file you had to update
git commit -m "feat(categories): the categorizer and the list-open sweep skip a list with categories off

<trailers>"
```

---

### Task 3: Lists route saves and returns the switch

**Files:**
- Modify: `src/schemas/lists.ts` (`updateListSchema`)
- Modify: `app/api/lists/route.ts`:
  - The GET selects at lines 25 and 46, and the hand-written collab type near line 41.
  - The PATCH update flow at about lines 241-290.
- Test: `__tests__/unit/lists-route-categorize.test.ts`. Create
  `__tests__/unit/lists-get-columns.test.ts` if no existing GET test can host the column check.

**Interfaces:**
- Consumes: the Task 1 RPC `set_list_categories_enabled`.
- Produces:
  - PATCH `/api/lists` accepts `{ id, categoriesEnabled: boolean }`.
  - GET `/api/lists` rows carry `categories_enabled: boolean`.

- [ ] **Step 1: Write the failing tests**

In `lists-route-categorize.test.ts`, extend `use()`:
- Add `opts.switchFails?: boolean`, `opts.switchMissing?: boolean` and `opts.owner?: string`
  (default `"u1"`).
- The `lists` select returns `{ owner_id: opts.owner ?? "u1" }`.
- The RPC `set_list_categories_enabled` returns:
  - `{ data: null, error: { message: "boom" } }` if `switchFails`.
  - `{ data: [], error: null }` if `switchMissing`.
  - Else `{ data: [{ id: LIST, categories_enabled: (c.values as { p_enabled: boolean }).p_enabled }], error: null }`.

Add:

```ts
describe("PATCH /api/lists categories switch", () => {
  const switchCalls = () => h.fake.calls.filter((c) => c.table === "set_list_categories_enabled");

  it("turning off runs the cleanup function, answers with the saved row and sorts nothing", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LIST, categories_enabled: false });
    expect(switchCalls().map((c) => c.values)).toEqual([{ p_list_id: LIST, p_enabled: false }]);
    expect(h.fake.calls.filter((c) => c.table === "lists" && c.op === "update")).toEqual([]);
    expect(h.after).toEqual([]);
  });

  it("turning on sets the switch and sorts the list from zero right away", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: true }));
    expect(res.status).toBe(200);
    expect(switchCalls().map((c) => c.values)).toEqual([{ p_list_id: LIST, p_enabled: true }]);
    expect(h.after).toHaveLength(1);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.objectContaining({ supabase: expect.anything() }), LIST, "pending");
  });

  it("answers 500 and sorts nothing when the switch cannot be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    use({ switchFails: true });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: true }));
    expect(res.status).toBe(500);
    expect(h.after).toEqual([]);
  });

  it("answers 404 when the list is gone by the time the switch is saved", async () => {
    use({ switchMissing: true });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(404);
    expect(h.after).toEqual([]);
  });

  it("only the owner can change it", async () => {
    use({ owner: "someone-else" });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(403);
    expect(switchCalls()).toEqual([]);
  });

  it("is an update on its own, and must be a boolean", async () => {
    use();
    expect((await PATCH(patch({ id: LIST }))).status).toBe(400);
    expect((await PATCH(patch({ id: LIST, categoriesEnabled: "no" }))).status).toBe(400);
    expect(switchCalls()).toEqual([]);
  });

  it("a rename alongside it saves both", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, name: "Flours", categoriesEnabled: false }));
    expect(res.status).toBe(200);
    expect(h.fake.calls.find((c) => c.table === "lists" && c.op === "update")!.values).toEqual({ name: "Flours" });
    expect(switchCalls()).toHaveLength(1);
  });
});
```

`vi` is already imported in this file. Add `vi.restoreAllMocks()` to `beforeEach` if you spy.

For GET `/api/lists`, add `__tests__/unit/lists-get-columns.test.ts`:
- Mock `@/src/lib/api-auth` (`verifyUserAuth` → `{ success: true, userId: "u1" }`),
  `@/src/lib/rate-limit` and `@/src/lib/supabase`, as `lists-route-categorize.test.ts` does.
- Answer every `lists` select with `[]` and every other table with `[]`. Read the GET handler first to
  see which reads it makes: collaborators, `user_list_state`, the counts RPC.
- Call `GET(new NextRequest("https://app.test/api/lists"))`.
- Assert that every `lists` select call's `cols` contains `categories_enabled`.
- Then give the owned-lists read one row, and assert the response row has `categories_enabled`.

If the GET makes the collab read only when there are collaborator rows, return one collaborator row so
the second select runs. Assert there are exactly 2 `lists` select calls.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/unit/lists-route-categorize.test.ts __tests__/unit/lists-get-columns.test.ts`
Expected: FAIL. The schema strips `categoriesEnabled`, so you get 400 for "No updates provided", and
`cols` lacks the column.

- [ ] **Step 3: Implement**

`src/schemas/lists.ts`, in `updateListSchema`:

```ts
  // The grocery categories switch: off deletes the list's categories (set_list_categories_enabled).
  categoriesEnabled: z.boolean().optional(),
```

`app/api/lists/route.ts` GET:
- Both selects become
  `"id, name, owner_id, created_at, updated_at, type, icon, color, categories_enabled"`.
- Add `categories_enabled: boolean;` to the hand-written collab row type.

PATCH update flow, replacing everything from the destructure to the end of the handler:

```ts
  // Update flow (name, type, icon, color, the categories switch)
  const { name, type, icon, color, categoriesEnabled } = parsed.data;
  // ...name validation and owner check unchanged...

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (type !== undefined) updates.type = type;
  if (icon !== undefined) updates.icon = icon;
  if (color !== undefined) updates.color = color;

  if (Object.keys(updates).length === 0 && categoriesEnabled === undefined) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  let saved: unknown = null;
  if (Object.keys(updates).length > 0) {
    const { data: updated, error } = await supabase
      .from("lists")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) return dbError("lists/PATCH", "Update", error, { listId: id });
    saved = updated;
  }

  if (categoriesEnabled !== undefined) {
    // One transaction: off deletes the list's categories and every item's placement, under the
    // list row lock the categorizer's writes check, so a sort already running leaves nothing.
    const { data: rows, error: switchError } = await supabase.rpc("set_list_categories_enabled", {
      p_list_id: id,
      p_enabled: categoriesEnabled,
    });
    if (switchError) {
      return dbError("lists/PATCH", "Categories switch", switchError, { listId: id, enabled: categoriesEnabled });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) {
      console.warn("[lists/PATCH] Categories switch found no live list", { listId: id, enabled: categoriesEnabled });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.info("[lists/PATCH] Categories switched", { listId: id, enabled: categoriesEnabled });
    saved = row;
  }

  // A list that becomes a grocery list, or turns its categories on, is sorted right away, not
  // on its next open. categorizeList itself skips a list that is not grocery with categories on.
  if (type === "grocery" || categoriesEnabled === true) after(() => categorizeList({ supabase }, id, "pending"));

  return NextResponse.json(saved);
```

Check that `dbError`'s context parameter accepts `enabled: boolean`. If its type only allows strings,
pass `enabled: String(categoriesEnabled)`.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. The existing lists route tests must stay green unchanged.

- [ ] **Step 5: Bite**
- Remove `categoriesEnabled` from the schema: the switch tests FAIL.
- Remove `|| categoriesEnabled === true`: "turning on … sorts" FAILS.
- Drop `categories_enabled` from one GET select: the columns test FAILS.

Restore each change after checking.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/lists.ts app/api/lists/route.ts __tests__/unit/lists-route-categorize.test.ts __tests__/unit/lists-get-columns.test.ts
git commit -m "feat(lists): save the categories switch through one function; lists carry it

<trailers>"
```

---

### Task 4: Client state: useListData and realtime

**Files:**
- Modify: `src/utils/category-state.ts` (add `clearItemCategories`)
- Modify: `src/hooks/useListData.ts`:
  - The `ListSummary` type.
  - New state.
  - `clearCategorization`.
  - The return object.
- Modify: `src/hooks/useListRealtime.ts`: the params interface, the `lists` UPDATE branch and the
  dependency array.
- Modify: `app/(app)/list/[id]/page.tsx`: the `useListData` destructure and the `useListRealtime({...})`
  call only. The UI changes are Task 5.
- Test: `__tests__/unit/list-realtime-metadata.test.ts`, `__tests__/unit/list-data-categories.test.ts`,
  and a new `__tests__/unit/clear-item-categories.test.ts`.

**Interfaces:**
- Produces:
  - `useListData` also returns:
    - `categoriesEnabled: boolean`
    - `setCategoriesEnabled: React.Dispatch<React.SetStateAction<boolean>>`
    - `clearCategorization: () => void`
  - `useListRealtime` params gain `setCategoriesEnabled` and `clearCategorization` (same types).
  - `export function clearItemCategories(items: ItemData[]): ItemData[]` in
    `src/utils/category-state.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/unit/clear-item-categories.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clearItemCategories } from "@/src/utils/category-state";
import type { ItemData } from "@/src/types";

const item = (over: Partial<ItemData>): ItemData => ({ id: "x", text: "flour", completed: false, position: 1, ...over } as ItemData);

describe("clearItemCategories", () => {
  it("takes every item out of its category and unlocks hand placements", () => {
    const out = clearItemCategories([
      item({ id: "a", category_id: "c1", category_locked: false }),
      item({ id: "b", category_id: "c2", category_locked: true }),
      item({ id: "c", category_id: null, category_locked: true }),
      item({ id: "d", category_id: null, category_locked: false }),
    ]);
    expect(out.map((i) => [i.id, i.category_id, i.category_locked])).toEqual([
      ["a", null, false], ["b", null, false], ["c", null, false], ["d", null, false],
    ]);
  });

  it("keeps untouched rows as they are, and the same array when nothing had a category", () => {
    const plain = item({ id: "d", category_id: null, category_locked: false });
    const placed = item({ id: "a", category_id: "c1" });
    const out = clearItemCategories([plain, placed]);
    expect(out[0]).toBe(plain);
    const none = [plain];
    expect(clearItemCategories(none)).toBe(none);
  });
});
```

In `list-realtime-metadata.test.ts`:
- Extend `page()`. Add `enabled: true as boolean` to `state`, and to params
  `setCategoriesEnabled: apply<boolean>("enabled")` and
  `clearCategorization: vi.fn()`. Return `clearCategorization` from `page()`.
- Update the two `toEqual` state assertions at the end to include `enabled: true`.
- Add these tests:

```ts
  it("categories turned off elsewhere switch grouping off and clear the categorization at once", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Flours", type: "grocery", categories_enabled: false });

    expect(p.state.enabled).toBe(false);
    expect(p.clearCategorization).toHaveBeenCalledTimes(1);
  });

  it("categories turned on elsewhere switch grouping on and clear nothing", () => {
    const p = page("grocery");
    p.state.enabled = false;

    p.listUpdate({ name: "Flours", type: "grocery", categories_enabled: true });

    expect(p.state.enabled).toBe(true);
    expect(p.clearCategorization).not.toHaveBeenCalled();
  });

  it("an update without the switch leaves it as it is", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Renamed" });

    expect(p.state.enabled).toBe(true);
    expect(p.clearCategorization).not.toHaveBeenCalled();
  });
```

In `list-data-categories.test.ts`, read the file's harness first. It stubs React and fetch, and runs
`useListData` as a function. Add a `describe("useListData categories switch")` with:
1. The switch's initial value. `/api/lists` answers the list with `categories_enabled: false`: after
   `fetchItems()`, `categoriesEnabled` is `false`.
2. A list summary without the field (an old server) opens with `categoriesEnabled === true`.
3. `clearCategorization()`:
   - It empties `categories` and clears `category_id` and `category_locked` on the loaded items.
   - Load a grocery list whose categories fetch returns one category and whose items carry
     `category_id: "c1"` and `category_locked: true`.
   - Call `clearCategorization()`, then read the state again.

Use the file's own `stubFetch`/`stubRoutes` and state-reading helpers. Extend `stubFetch` with an
optional list-field override if it needs one.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/unit/clear-item-categories.test.ts __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-categories.test.ts`
Expected: FAIL. `clearItemCategories` doesn't exist, the realtime handler ignores the field, and the
hook returns no `categoriesEnabled`.

- [ ] **Step 3: Implement**

`src/utils/category-state.ts`. Add the `ItemData` type import if it's missing:

```ts
/** Every item out of its category, hand placements unlocked: what turning categories off leaves.
 *  The same array when no item had either, so an idle call re-renders nothing. */
export function clearItemCategories(items: ItemData[]): ItemData[] {
  if (!items.some((i) => i.category_id || i.category_locked)) return items;
  return items.map((i) => (i.category_id || i.category_locked ? { ...i, category_id: null, category_locked: false } : i));
}
```

`useListData.ts`:
- Add `categories_enabled?: boolean;` to `ListSummary`.
- Add state beside `categories`:

```ts
  // The grocery categories switch. An old server sends no field: that list is sorted, as before.
  const [categoriesEnabled, setCategoriesEnabled] = useState(true);
```

- In the `if (currentList)` block, after `setListColor(...)`:

```ts
          setCategoriesEnabled(currentList.categories_enabled !== false);
```

- After `loadCategories`:

```ts
  // Turning categories off deleted them on the server (set_list_categories_enabled): match it on
  // screen at once. An item left holding a deleted category would sit under "Sorting…" after
  // turning back on, because retrySorting only fills items with no category.
  const clearCategorization = useCallback(() => {
    setCategories((prev) => (prev.length ? [] : prev));
    setItems((prev) => clearItemCategories(prev));
  }, []);
```

- Import `clearItemCategories` next to `sortCategories`.
- Add `categoriesEnabled, setCategoriesEnabled, clearCategorization` to the return object.

`useListRealtime.ts`:
- Add to the params interface:

```ts
  setCategoriesEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  /** Categories were turned off: clear them on screen at once (useListData.clearCategorization). */
  clearCategorization: () => void;
```

- Destructure both. In the `lists` UPDATE branch, after the color line:

```ts
          // The owner switched categories on or off. Every UPDATE carries the full row
          // (REPLICA IDENTITY FULL), so this runs on each one; clearing is idempotent.
          if (typeof newRec.categories_enabled === "boolean") {
            setCategoriesEnabled(newRec.categories_enabled);
            if (!newRec.categories_enabled) clearCategorization();
          }
```

- Add both to the `useCallback` dependency array.

`page.tsx`:
- Add `setCategoriesEnabled, clearCategorization` to the `useListData` destructure. Leave
  `categoriesEnabled` out, because Task 5 adds it with its first use.
- Add `setCategoriesEnabled,` and `clearCategorization,` to the `useListRealtime({...})` call, after
  `setCategories,`.

- [ ] **Step 4: Run the full suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Other tests that stub `useListData` (for example `list-type-switch.test.ts`) keep
working: a missing `clearCategorization` in a stub is only called on an off event, and the stub hooks
don't run it. Run them to confirm.

- [ ] **Step 5: Bite**
- Remove the `if (!newRec.categories_enabled) clearCategorization();` line: the realtime off test FAILS.
- Make `clearItemCategories` return `items` unconditionally: its tests FAIL.
- Change `!== false` to `=== true` in `useListData`: the old-server test FAILS.

Restore each change after checking.

- [ ] **Step 6: Commit**

```bash
git add src/utils/category-state.ts src/hooks/useListData.ts src/hooks/useListRealtime.ts "app/(app)/list/[id]/page.tsx" __tests__/unit/clear-item-categories.test.ts __tests__/unit/list-realtime-metadata.test.ts __tests__/unit/list-data-categories.test.ts
git commit -m "feat(list): the categories switch reaches the screen, live, and off clears it at once

<trailers>"
```

---

### Task 5: The switch in list settings, grouping follows it, copy

**Files:**
- Modify: `app/(app)/list/[id]/page.tsx`:
  - The `grouped:` option (line 134).
  - The settings sheet (about lines 465-520).
  - A new handler.
  - The `askConfirm` import.
- Modify: `messages/en.json`, `messages/he.json` and `messages/ru.json` (the `categories` block).
- Modify: `README.md` (one Features bullet).
- Test: `__tests__/unit/grouped-list-wiring.test.ts`, `__tests__/unit/categories-sheet-wiring.test.ts`,
  and a new `__tests__/unit/categories-switch-page.test.ts`.

**Interfaces:**
- Consumes: from Task 4's `useListData` return, `categoriesEnabled`, `setCategoriesEnabled`,
  `clearCategorization` and `loadCategories`. `askConfirm(message, onConfirm)` comes from
  `@/src/types/telegram`.
- Produces: the user-facing switch.

**Design (the controller ran frontend-design; follow it):**
- **One full-width row**, with the label at the start and the switch at the end. The whole row is the
  `role="switch"` button, so the touch target is the row (at least 44px tall).
- **Mirror the sheet's existing tokens:**
  - `bg-tg-secondary-bg rounded-2xl`, the same as the Categories and Close buttons.
  - The track is `bg-tg-button` when on and `bg-tg-hint/30` when off.
  - The knob is `bg-white` with `shadow-sm`.
- **The knob's position uses logical properties and an RTL flip,** so it sits at the end side when on in
  both Hebrew and English.
- **Motion:** `transition-colors` on the track and `transition-transform` on the knob, both under
  `motion-safe:`. No other animation.

- [ ] **Step 1: Write the failing tests**

Update `grouped-list-wiring.test.ts`, in the test "derives category groups only for grocery lists…":

```ts
    expect(call).toMatch(/grouped: listType === "grocery" && categoriesEnabled/);
```

Update `categories-sheet-wiring.test.ts`, in "the settings sheet offers Categories on grocery lists
only". Rename it to "…on grocery lists with categories on":

```ts
    expect(page).toMatch(
      /\{listType === "grocery" && categoriesEnabled && \(\s*<button\s+onClick=\{\(\) => \{[^}]*setShowCategories\(true\);?[^}]*\}\}[^<]*>\s*\{t\('categories\.manage'\)\}\s*<\/button>\s*\)\}/
    );
```

Create `__tests__/unit/categories-switch-page.test.ts` by copying the harness from
`__tests__/unit/list-type-switch.test.ts`: the React slot mocks, `find`/`findAll`, `render`,
`settle`, `errorToast` and the module mocks. Make these changes:
- `S` gains these fields:
  - `listType: "grocery"`
  - `enabled: true`
  - `setCategoriesEnabled: vi.fn()`
  - `clearCategorization: vi.fn()`
  - `confirmAnswer: true`
  - `confirms: [] as string[]`
- The `useListData` mock returns `listType: S.listType, categoriesEnabled: S.enabled,
  setCategoriesEnabled: S.setCategoriesEnabled, clearCategorization: S.clearCategorization`,
  plus everything the original stub returns.
- Add a mock:

```ts
vi.mock("@/src/types/telegram", async (orig) => ({
  ...(await orig<typeof import("@/src/types/telegram")>()),
  askConfirm: (message: string, onConfirm: () => void) => { S.confirms.push(message); if (S.confirmAnswer) onConfirm(); },
}));
```

- `beforeEach` resets those fields and keeps the PATCH fetch mock from the original.

Helpers:

```ts
const openSettings = () => {
  const header = find(render(), (el) => el.type === ListHeader);
  (header!.props.onSettings as () => void)();
};
const theSwitch = () => find(render(), (el) => el.props.role === "switch");
const press = () => (theSwitch()!.props.onClick as () => void)();
const categoriesButton = () =>
  find(render(), (el) => el.type === "button" && findText(el) === "categories.manage");
```

`findText` concatenates string children. Write it with the existing `find` recursion style.

Tests:

```ts
describe("the categories switch in list settings", () => {
  it("shows on a grocery list, checked when categories are on", () => {
    openSettings();
    expect(theSwitch()!.props["aria-checked"]).toBe(true);
    S.enabled = false;
    expect(theSwitch()!.props["aria-checked"]).toBe(false);
  });

  it("is not offered on a regular list", () => {
    S.listType = "regular";
    openSettings();
    expect(theSwitch()).toBeUndefined();
  });

  it("turning off asks first; declining changes and sends nothing", () => {
    S.confirmAnswer = false;
    openSettings();
    press();
    expect(S.confirms).toEqual(["categories.confirmOff"]);
    expect(S.setCategoriesEnabled).not.toHaveBeenCalled();
    expect(S.clearCategorization).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a confirmed off clears the screen at once, then saves", async () => {
    openSettings();
    press();
    expect(S.setCategoriesEnabled).toHaveBeenCalledWith(false);
    expect(S.clearCategorization).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(S.clearCategorization.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: false });
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(S.setCategoriesEnabled.mock.calls).toEqual([[false]]);
    expect(errorToast()).toBeNull();
  });

  it("an off the server refused turns categories back on, reloads them, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openSettings();
    press();
    patch.resolve({ ok: false, status: 403 });
    await settle();
    expect(S.setCategoriesEnabled.mock.calls).toEqual([[false], [true]]);
    expect(loadCategories).toHaveBeenCalledTimes(1);
    expect(errorToast()).toBe("errors.generic");
  });

  it("turning on asks nothing and saves", async () => {
    S.enabled = false;
    openSettings();
    press();
    expect(S.confirms).toEqual([]);
    expect(S.setCategoriesEnabled).toHaveBeenCalledWith(true);
    expect(S.clearCategorization).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: true });
  });

  it("an on that could not be sent turns it back off and says so, reloading nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    S.enabled = false;
    openSettings();
    press();
    patch.reject(new TypeError("Failed to fetch"));
    await settle();
    expect(S.setCategoriesEnabled.mock.calls).toEqual([[true], [false]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("the Categories button follows the switch", () => {
    openSettings();
    expect(categoriesButton()).toBeDefined();
    S.enabled = false;
    expect(categoriesButton()).toBeUndefined();
  });
});
```

`fetchMock`, `patch` and `loadCategories` are the harness variables from the copied file. Wire
`S.loadCategories` the way the original does.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run __tests__/unit/categories-switch-page.test.ts __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/categories-sheet-wiring.test.ts`
Expected: FAIL. There is no switch yet, and the gates don't match.

- [ ] **Step 3: Implement**

`page.tsx`:
- Add `import { askConfirm } from "@/src/types/telegram";`.
- Change `grouped: listType === "grocery"` to `grouped: listType === "grocery" && categoriesEnabled`.

Add the handler near the other settings handlers, before the `return`. Keep it outside JSX:

```tsx
  // Off deletes the list's categories on the server (set_list_categories_enabled), so it asks
  // first and clears the screen at once. A failed save puts the switch back; after a failed off
  // the categories are loaded again, since the cleanup did not run.
  const saveCategoriesEnabled = (enabled: boolean) => {
    const jwt = jwtRef.current;
    if (!jwt) {
      console.warn("[List] Categories switch not sent: no session yet, listId:", listId);
      setErrorToast(t('errors.generic'));
      setTimeout(() => setErrorToast(null), 3000);
      return;
    }
    setCategoriesEnabled(enabled);
    if (!enabled) clearCategorization();
    fetch("/api/lists", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: listId, categoriesEnabled: enabled }),
    })
      .then((res) => throwIfNotOk(res, "Categories switch"))
      .catch((err) => {
        console.error("[List] Failed to switch categories, listId:", listId, "enabled:", enabled, err);
        setCategoriesEnabled(!enabled);
        if (!enabled) void loadCategories();
        setErrorToast(t('errors.generic'));
        setTimeout(() => setErrorToast(null), 3000);
      });
  };
  const toggleCategories = () => {
    if (categoriesEnabled) askConfirm(t('categories.confirmOff'), () => saveCategoriesEnabled(false));
    else saveCategoriesEnabled(true);
  };
```

Check how `throwIfNotOk` is used in the type handler. Mirror it, and check whether it returns or
throws.

The settings sheet: between the type control `</div>` and the Categories button, add the switch.
Change the Categories gate:

```tsx
            {listType === "grocery" && (
              <button
                type="button"
                role="switch"
                aria-checked={categoriesEnabled}
                onClick={toggleCategories}
                className="w-full min-h-11 flex items-center justify-between gap-3 py-3 px-4 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium text-start active:scale-[0.98]"
              >
                <span>{t('categories.enabled')}</span>
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-7 w-12 shrink-0 rounded-full motion-safe:transition-colors ${categoriesEnabled ? "bg-tg-button" : "bg-tg-hint/30"}`}
                >
                  <span
                    className={`absolute top-0.5 start-0.5 h-6 w-6 rounded-full bg-white shadow-sm motion-safe:transition-transform ${categoriesEnabled ? "translate-x-5 rtl:-translate-x-5" : ""}`}
                  />
                </span>
              </button>
            )}
            {listType === "grocery" && categoriesEnabled && (
              <button
                onClick={() => { setShowSettings(false); setShowCategories(true); }}
```

That is the existing Categories button with its `onClick` body unchanged. Two changes:
- Its gate.
- `mt-3` added to the front of its `className`. The switch row carries no margin, so the gap above
  Close stays 16px whether or not the Categories button shows. A `<button>` is inline-block, so its
  margins don't collapse.

The wiring regex still matches.

Messages: add to the `categories` block of each file, after `"error"` (mind the comma):
- en: `"enabled": "Sort into categories"`, `"confirmOff": "Turn off sorting? The list's categories and their order will be deleted."`
- he: `"enabled": "מיון לפי קטגוריות"`, `"confirmOff": "לכבות את המיון? הקטגוריות של הרשימה והסדר שלהן יימחקו."`
- ru: `"enabled": "Сортировка по категориям"`, `"confirmOff": "Отключить сортировку? Категории списка и их порядок будут удалены."`

README Features: after the "Recurring grocery staples" bullet, add:

```markdown
- **Store-aisle sorting** — grocery lists group items into the store sections the AI picks (drag sections into your walk order). A list with nothing to sort can switch it off in list settings, which deletes its sections.
```

- [ ] **Step 4: Run the full gate**

Run: `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit`
Expected: PASS. Never run `npm run build`.

- [ ] **Step 5: Bite**
- Remove `&& categoriesEnabled` from `grouped:`: the grouped wiring test FAILS.
- Remove `if (!enabled) clearCategorization();`: "a confirmed off clears…" FAILS.
- Remove `if (!enabled) void loadCategories();`: "an off the server refused…" FAILS.
- Make the toggle call `saveCategoriesEnabled(false)` without `askConfirm`: "turning off asks first"
  FAILS.
- Drop `&& categoriesEnabled` from the Categories gate: both its tests FAIL.

Restore each change after checking.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/list/[id]/page.tsx" messages/en.json messages/he.json messages/ru.json README.md __tests__/unit/grouped-list-wiring.test.ts __tests__/unit/categories-sheet-wiring.test.ts __tests__/unit/categories-switch-page.test.ts
git commit -m "feat(ui): Sort into categories switch in list settings; off asks first

<trailers>"
```

---

## After all tasks (controller)

1. **Whole-branch review:** an Opus reviewer covering correctness, races, RTL/a11y and copy. Fix every
   valid finding.
2. **Controller bite pass** over every guard listed in the task Bite steps.
3. **Full gate:** `npx eslint . && npx vitest run && npx next typegen && npx tsc --noEmit && npx next build`.
4. **Ship:**
   - Push to main.
   - Watch Vercel; migration 032 applies on deploy.
   - Update the memory files: `project_grocery_categories.md` loses "always on" and gets a pointer to a
     new memory for the switch.
   - Delete this plan file in a final commit, then push and ping.
