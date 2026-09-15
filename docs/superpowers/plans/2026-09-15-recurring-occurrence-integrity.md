# Recurring Occurrence Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Done tap creates exactly one next occurrence, from any surface; and snoozing a recurring reminder no longer ends the series.

**Architecture:** Turn `completeRecurringItem`'s "mark completed" step into a single-statement compare-and-swap that also acts as the idempotency claim, so a losing caller does nothing. Then stop the client replaying an in-flight mutation, and revert the snooze over-correction that the CAS now makes safe.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (PostgREST), Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-recurring-occurrence-integrity-design.md`

## Global Constraints

- Vitest `include` is `["__tests__/**/*.test.ts"]` (`vitest.config.ts:11`). **`.tsx` test files are silently skipped.** There is no jsdom — React hooks and components CANNOT be rendered or tested. Test pure functions, classes, or inspect source text.
- Path alias `@/` resolves to the repo root.
- `npx tsc --noEmit` must stay clean.
- `npx eslint .` must report **exactly** the 6 pre-existing problems (3 errors, 3 warnings), in these 5 files: `app/list/[id]/page.tsx` (2), `app/login/callback/page.tsx`, `components/ReminderSheet.tsx`, `components/TimePicker.tsx`, `src/hooks/useItemHandlers.ts`. `useItemHandlers.ts` is already on that list — do not "fix" its existing warning.
- **Measured baseline: 21 test files, 142 tests passing.**
- Migrations are append-only; **this plan adds none**.
- Do not connect to a database. `.env.local` `DATABASE_URL` points at production. Do not read secrets.
- `scripts/diagnose-reminder-dupes.mjs` is an untracked read-only diagnostic. Leave it alone; do not run it.
- Do not change `getNextOccurrence` — the series-drift consequence is accepted in the spec.

---

### Task 1: Compare-and-swap claim in `completeRecurringItem`

The whole fix rests on one property: of N concurrent callers, exactly one may create an occurrence. Postgres gives this for free in a single-statement `UPDATE` — under READ COMMITTED the second writer blocks on the row lock, then re-evaluates its `WHERE` against the committed version and matches zero rows.

**Files:**
- Modify: `src/services/recurring.ts:19-75`
- Test: `__tests__/unit/recurring-claim.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CompleteRecurringOutcome = { status: "created"; newItemId: string; nextRemindAt: string } | { status: "already-completed" } | { status: "error" }`
  - `completeRecurringItem(supabase, params): Promise<CompleteRecurringOutcome>` — **return type changes** from `{ newItemId, nextRemindAt } | null`. Task 2 updates the web caller. `src/services/bot.ts:450` ignores the return value and needs no change.

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/recurring-claim.test.ts`. The fake mirrors the PostgREST builder shape this function actually uses, so the assertions are about real call sequences, not about a mock's own behaviour:

```ts
import { describe, it, expect } from "vitest";
import { completeRecurringItem } from "@/src/services/recurring";

type Recorded = {
  table: string;
  op: "update" | "insert";
  values: Record<string, unknown>;
  filters: string[];
};

// Minimal stand-in for the PostgREST builder chain completeRecurringItem uses:
// from(t).update(v)/.insert(v) then .eq/.neq/.is/.select/.single, awaited.
function fakeSupabase(claimRows: unknown[]) {
  const calls: Recorded[] = [];

  const make = (table: string, op: Recorded["op"], values: Record<string, unknown>) => {
    const rec: Recorded = { table, op, values, filters: [] };
    calls.push(rec);

    const result = () => {
      // The claim is the items UPDATE that sets completed: true.
      if (table === "items" && op === "update" && values.completed === true) {
        return { data: claimRows, error: null };
      }
      if (table === "items" && op === "insert") {
        return { data: { id: "new-item-1" }, error: null };
      }
      return { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
      neq: (c: string, v: unknown) => { rec.filters.push(`neq:${c}=${v}`); return chain; },
      is: (c: string, v: unknown) => { rec.filters.push(`is:${c}=${v}`); return chain; },
      select: () => chain,
      single: () => chain,
      then: (onOk: (r: unknown) => unknown) => Promise.resolve(result()).then(onOk),
    };
    return chain;
  };

  const client = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => make(table, "update", values),
      insert: (values: Record<string, unknown>) => make(table, "insert", values),
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls, client: client as any };
}

const PARAMS = {
  itemId: "item-1",
  listId: "list-1",
  userId: "user-1",
  text: "לתזכר לקוחות לגבי לחם",
  remindAt: "2026-09-13T04:30:00.000Z",
  recurrence: "weekly",
  isShared: false,
};

describe("completeRecurringItem claim", () => {
  it("creates exactly one occurrence when it wins the claim", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    const out = await completeRecurringItem(client, PARAMS);

    expect(out.status).toBe("created");
    if (out.status === "created") expect(out.newItemId).toBe("new-item-1");
    expect(calls.filter((c) => c.table === "items" && c.op === "insert")).toHaveLength(1);
    expect(calls.filter((c) => c.table === "item_reminders" && c.op === "insert")).toHaveLength(1);
  });

  it("creates NOTHING when another caller already claimed the item", async () => {
    const { calls, client } = fakeSupabase([]);
    const out = await completeRecurringItem(client, PARAMS);

    expect(out.status).toBe("already-completed");
    // The regression this guards: two concurrent Done taps 29ms apart each inserted
    // an occurrence, leaving two live duplicates in the user's reminders list.
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("does not soft-delete prior occurrences when it loses the claim", async () => {
    const { calls, client } = fakeSupabase([]);
    await completeRecurringItem(client, PARAMS);
    expect(calls.filter((c) => c.values.deleted_at !== undefined)).toHaveLength(0);
  });

  it("claims with a compare-and-swap on completed=false, not a blind update", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    await completeRecurringItem(client, PARAMS);

    const claim = calls.find((c) => c.table === "items" && c.values.completed === true);
    expect(claim).toBeDefined();
    expect(claim!.filters).toContain("eq:id=item-1");
    expect(claim!.filters).toContain("eq:completed=false");
    // Deleting is final — a deleted item must not spawn a successor.
    expect(claim!.filters).toContain("is:deleted_at=null");
  });

  it("claims before doing anything else", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    await completeRecurringItem(client, PARAMS);
    expect(calls[0].table).toBe("items");
    expect(calls[0].values.completed).toBe(true);
  });

  it("reports an error without inserting when the claim query fails", async () => {
    // The insert throws if reached, so this asserts by failing loudly, not by
    // inspecting a recorder that would be empty either way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: any = {
      from: (table: string) => ({
        update: () => ({
          eq: function () { return this; },
          is: function () { return this; },
          neq: function () { return this; },
          select: function () { return this; },
          single: function () { return this; },
          then: (onOk: (r: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: "boom" } }).then(onOk),
        }),
        insert: () => { throw new Error(`must not insert into ${table}`); },
      }),
    };
    const out = await completeRecurringItem(broken, PARAMS);
    expect(out.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/recurring-claim.test.ts`
Expected: FAIL. The current function returns `{ newItemId, nextRemindAt } | null`, so `out.status` is `undefined` and the first test fails on `expect(out.status).toBe("created")`. The second fails because the current code inserts unconditionally.

- [ ] **Step 3: Rewrite the function**

In `src/services/recurring.ts`, replace the whole of `completeRecurringItem` (lines 19-75; leave `getNextOccurrence` untouched) with:

```ts
export type CompleteRecurringOutcome =
  | { status: "created"; newItemId: string; nextRemindAt: string }
  | { status: "already-completed" }
  | { status: "error" };

export async function completeRecurringItem(
  supabase: SupabaseClient,
  params: {
    itemId: string;
    listId: string;
    userId: string;
    text: string;
    remindAt: string;
    recurrence: string;
    isShared: boolean;
  }
): Promise<CompleteRecurringOutcome> {
  const { itemId, listId, userId, text, remindAt, recurrence, isShared } = params;

  // 1. Claim the occurrence. This single-statement compare-and-swap IS the
  //    idempotency guard: under READ COMMITTED a concurrent second UPDATE blocks
  //    on the row lock, then re-evaluates `completed = false` against the committed
  //    version and matches zero rows. Exactly one caller gets a row back; the loser
  //    returns without creating anything.
  //
  //    This is what stops one Done tap producing two occurrences — whether the
  //    repeat comes from a replayed client mutation, a stale Telegram button, or a
  //    second recipient of a shared reminder. A time-window check cannot: it reads
  //    and then writes, so two callers can both read "not completed" first.
  //
  //    `deleted_at IS NULL` keeps this consistent with the delete-is-final rule —
  //    a deleted item never spawns a successor.
  const { data: claimed, error: claimError } = await supabase
    .from("items")
    .update({ completed: true, completed_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("completed", false)
    .is("deleted_at", null)
    .select("id");

  if (claimError) {
    console.error("[Recurring] Claim failed:", claimError);
    return { status: "error" };
  }
  if (!claimed || claimed.length === 0) {
    return { status: "already-completed" };
  }

  // 2. Soft-delete previous completed occurrences (same text, same list, not the current item)
  await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
    .eq("text", text)
    .eq("completed", true)
    .neq("id", itemId)
    .is("deleted_at", null);

  // 3. Calculate next occurrence
  const nextRemindAt = getNextOccurrence(new Date(remindAt), recurrence);

  // 4. Create new item with same text
  const { data: newItem, error: createError } = await supabase
    .from("items")
    .insert({ text, list_id: listId, created_by: userId, position: Date.now() })
    .select("id")
    .single();

  if (createError || !newItem) {
    console.error("[Recurring] Failed to create new item:", createError);
    return { status: "error" };
  }

  // 5. Create reminder on the new item
  await supabase.from("item_reminders").insert({
    item_id: newItem.id,
    list_id: listId,
    created_by: userId,
    remind_at: nextRemindAt.toISOString(),
    is_shared: isShared,
    recurrence,
  });

  return {
    status: "created",
    newItemId: newItem.id,
    nextRemindAt: nextRemindAt.toISOString(),
  };
}
```

Note the ordering change: the claim (was step 2) now runs first, so a loser never reaches the soft-delete or either insert.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/recurring-claim.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: either clean, or an error confined to `app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts` (its `if (!result)` is now always false). Both are acceptable — Task 2 rewrites that code either way. **If any OTHER file errors, stop and report it**: it means something destructures this return value that this plan did not account for (`src/services/bot.ts:450` is expected to ignore it).

- [ ] **Step 6: Commit**

```bash
git add src/services/recurring.ts __tests__/unit/recurring-claim.test.ts
git commit -m "fix: claim the occurrence atomically before creating a successor"
```

---

### Task 2: Update the callers

**Files:**
- Modify: `app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts:48-62`
- Modify: `src/hooks/useItemHandlers.ts:220-244`
- Test: none — the route and the hook are untestable here (no jsdom, no DB). Task 1 covers the logic.

**Interfaces:**
- Consumes: `CompleteRecurringOutcome` from Task 1.
- Produces: `POST .../complete-recurring` responds `201 { newItemId, nextRemindAt }` on creation, `200 { alreadyCompleted: true }` when another caller won, `500 { error }` on failure.

- [ ] **Step 1: Update the route**

In `app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts`, replace lines 48-62 (from `const result = await completeRecurringItem(` to the final `return`) with:

```ts
  const result = await completeRecurringItem(supabase, {
    itemId,
    listId,
    userId: auth.userId,
    text: item.text,
    remindAt,
    recurrence,
    isShared: isShared ?? false,
  });

  if (result.status === "error") {
    return NextResponse.json({ error: "Failed to create next occurrence" }, { status: 500 });
  }

  // Another caller (a replayed mutation, a stale Telegram button, a second recipient
  // of a shared reminder) already completed this occurrence. Not an error — report it
  // so the client skips its optimistic insert instead of duplicating the winner's row.
  if (result.status === "already-completed") {
    return NextResponse.json({ alreadyCompleted: true }, { status: 200 });
  }

  return NextResponse.json(
    { newItemId: result.newItemId, nextRemindAt: result.nextRemindAt },
    { status: 201 }
  );
```

A 200 matters: `useMutationQueue.ts:75-81` drops 4xx and `:83-85` retries 5xx, so anything other than a success status would either surface a false error or spin.

- [ ] **Step 2: Update the client's optimistic insert**

In `src/hooks/useItemHandlers.ts`, replace this line (currently `:220`):

```ts
            const { newItemId, nextRemindAt } = await recurRes.json();
```

with:

```ts
            const recurBody = await recurRes.json();
            // Another caller already created this occurrence — its row arrives via
            // Realtime. Inserting here would put a second copy in local state.
            if (recurBody.alreadyCompleted || !recurBody.newItemId) return;
            const { newItemId, nextRemindAt } = recurBody;
```

The `return` exits the mutation's `execute` closure normally, so the mutation is treated as successful and dequeued (`useMutationQueue.ts:52-54`) — which is correct, because the work is done.

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean (the Task 1 error is now resolved); 22 files, 148 tests passing.

- [ ] **Step 4: Commit**

```bash
git add "app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts" src/hooks/useItemHandlers.ts
git commit -m "fix: handle an already-claimed occurrence without erroring or duplicating"
```

---

### Task 3: Stop the client replaying an in-flight mutation

This is what actually fired in production: `addMutation` enqueues, fires without awaiting, and a `visibilitychange` flush picks the same entry out of the queue and runs the same cached closure again. In-flight state is ephemeral, so it lives in memory on the queue object, never in localStorage.

**Files:**
- Modify: `src/utils/mutation-queue.ts` (append to the class)
- Modify: `src/hooks/useMutationQueue.ts:49-89` and `:101-158`
- Test: `__tests__/unit/mutation-queue.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `MutationQueue` gains `markInFlight(id: string): void`, `clearInFlight(id: string): void`, `isInFlight(id: string): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/unit/mutation-queue.test.ts`. The file already imports `MutationQueue` and mocks `localStorage` in a `beforeEach`; reuse both.

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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/mutation-queue.test.ts`
Expected: FAIL — `q.markInFlight is not a function`.

- [ ] **Step 3: Add the tracking to the class**

In `src/utils/mutation-queue.ts`, add the field next to `storageKey`:

```ts
export class MutationQueue {
  private storageKey: string;
  // Ephemeral, per-session, never persisted: which queued mutations have a request
  // in flight right now. A queued mutation is only removed on success, so without
  // this a flush triggered mid-request (focus / visibilitychange / the 45-minute
  // timer) re-runs the same executor and the request lands twice.
  private inFlight = new Set<string>();
```

and these methods before the closing brace:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/mutation-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the hook**

In `src/hooks/useMutationQueue.ts`, in `executeMutation`, wrap the body so the marker is set before the call and cleared on every exit path. Replace lines 51-56 (`try { const result = await execute(); ... } catch (error: unknown) {`) with:

```ts
      queueRef.current.markInFlight(id);
      try {
        const result = await execute();
        queueRef.current.dequeue(id);
        pendingExecutors.current.delete(id);
        return result;
      } catch (error: unknown) {
```

and add a `finally` to that same `try`, immediately after the closing brace of the `catch` block (currently line 86 — the `}` that closes `catch`, before the `}` that closes the arrow function at `:87`):

```ts
      } finally {
        queueRef.current.clearInFlight(id);
      }
```

Then in `flushQueue`, immediately after the stale-mutation check (after the block ending at line 108, before the `failedTempIds` check at `:111`), add:

```ts
        // Skip anything already being sent — its caller will dequeue it on success.
        if (queueRef.current.isInFlight(mutation.id)) {
          continue;
        }
```

Finally, correct the comment in `addMutation` (currently `:174-175`):

```ts
      // Execute immediately. The queue entry stays until this succeeds, so a flush
      // triggered while the request is in flight would otherwise replay the same
      // executor — isInFlight is what prevents that.
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; 22 files, 153 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/utils/mutation-queue.ts src/hooks/useMutationQueue.ts __tests__/unit/mutation-queue.test.ts
git commit -m "fix: do not replay a mutation whose request is still in flight"
```

---

### Task 4: Snooze keeps the recurrence

Safe only because of Task 1. Do not do this task before Task 1 is committed.

**Files:**
- Modify: `src/services/bot.ts:560-566`
- Test: `__tests__/unit/snooze-keeps-recurrence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

The snooze handler is a branch inside a long Telegram callback function that needs a live bot and DB, so this is a source-inspection test — the same pattern as `__tests__/unit/no-deleted-item-leak.test.ts` and `__tests__/unit/no-list-order-table.test.ts`.

Create `__tests__/unit/snooze-keeps-recurrence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Snoozing used to clear `recurrence`, on the premise that "the next recurring
// instance was already created when this reminder fired". That was never true —
// the cron only stamps sent_at/cancelled_at; the next occurrence is created on
// Done. So clearing it silently ended the series.
// See docs/superpowers/specs/2026-09-15-recurring-occurrence-integrity-design.md
describe("reminder snooze", () => {
  const source = readFileSync(resolve(process.cwd(), "src/services/bot.ts"), "utf8");

  const snoozeUpdate = source.slice(
    source.indexOf('data.match(/^reminder_snooze:'),
    source.indexOf("// Get user timezone and language for display")
  );

  it("locates the snooze handler", () => {
    expect(snoozeUpdate.length).toBeGreaterThan(0);
    expect(snoozeUpdate).toContain("remind_at: newRemindAt.toISOString()");
  });

  it("does not clear the recurrence when snoozing", () => {
    expect(snoozeUpdate).not.toContain("recurrence: null");
  });

  it("still clears sent_at so the snoozed reminder fires again", () => {
    expect(snoozeUpdate).toContain("sent_at: null");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/unit/snooze-keeps-recurrence.test.ts`
Expected: FAIL on "does not clear the recurrence when snoozing" — the slice still contains `recurrence: null`.

- [ ] **Step 3: Make the change**

In `src/services/bot.ts`, replace the comment and update at lines 560-566:

```ts
    // Update reminder: new remind_at, clear sent_at, and clear recurrence
    // (the next recurring instance was already created when this reminder fired,
    // so the snoozed copy should be one-time only)
    await supabase
      .from("item_reminders")
      .update({ remind_at: newRemindAt.toISOString(), sent_at: null, recurrence: null })
      .eq("id", reminderId);
```

with:

```ts
    // Update reminder: new remind_at, clear sent_at. The recurrence is KEPT.
    //
    // This used to null the recurrence, on the premise that "the next recurring
    // instance was already created when this reminder fired". That was never true:
    // the cron only stamps sent_at/cancelled_at (app/api/cron/reminders/route.ts),
    // and the next occurrence is created when the user taps Done. Clearing the
    // recurrence therefore ended the series — the snoozed reminder fired once more
    // and Done took the one-time branch below.
    //
    // The duplicate chains that removal was meant to stop came from
    // completeRecurringItem running twice; its compare-and-swap claim now prevents
    // that at the source. Note the series re-anchors to the snoozed time.
    await supabase
      .from("item_reminders")
      .update({ remind_at: newRemindAt.toISOString(), sent_at: null })
      .eq("id", reminderId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/unit/snooze-keeps-recurrence.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/bot.ts __tests__/unit/snooze-keeps-recurrence.test.ts
git commit -m "fix: snoozing a recurring reminder no longer ends the series"
```

---

### Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: 23 files, 156 tests (142 baseline + 6 Task 1 + 5 Task 3 + 3 Task 4).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Lint**

Run: `npx eslint .`
Expected: exactly 6 problems (3 errors, 3 warnings) in the 5 files named in Global Constraints. Any other file, or any change in the counts, is a regression from this plan.

- [ ] **Step 4: Confirm no migration**

Run: `git diff --stat main -- supabase/migrations/`
Expected: empty.

- [ ] **Step 5: Manual check on the deployed app**

1. In a reminders list, set a **daily** recurring reminder. When it fires in Telegram, tap **Done**. Confirm exactly ONE new occurrence appears, dated one day later.
2. Tap **Done** again on that same (now stale) Telegram message. Confirm NO second occurrence appears.
3. Let a recurring reminder fire, tap **Snooze 30m**, then tap **Done** on the snoozed message. Confirm the next occurrence IS created (this is the regression fixed by Task 4), and note its time is anchored to the snoozed time.
4. Complete a recurring item in the web app while the phone backgrounds the Mini App mid-tap. Confirm only one occurrence results.

---

## Follow-up, not in this plan

Recorded in the spec's Scope "Out" section; each needs its own decision:

1. **Series drift across a snooze.** The next occurrence is computed from the snoozed `remind_at`, so snoozing re-anchors the series. Accepted deliberately in the spec; preserving the original anchor needs a `series_anchor_at` column.
2. **Stale Telegram buttons are harmless but still present.** The CAS makes a repeat tap a no-op, but the message still shows a ✅ that now does nothing visible. Consider editing the message's markup when an occurrence is completed elsewhere.
3. **`reminder_done` has no membership check** (`src/services/bot.ts:405`) — unlike the approve/decline branch at `:337-343`. Any Telegram user who knows a reminder id can act on it.
4. **The existing duplicate row in production** (`26240c02`, text `לתזכר לקוחות לגבי לחם`) is not cleaned up by this change. Delete it in-app; deletion is final as of `2026-09-08`.
