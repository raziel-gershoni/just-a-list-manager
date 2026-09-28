import { describe, it, expect } from "vitest";
import { completeRecurringItem } from "@/src/services/recurring";

type Recorded = {
  table: string;
  op: "update" | "insert" | "select";
  values: Record<string, unknown>;
  filters: string[];
};

// Minimal stand-in for the PostgREST builder chain completeRecurringItem uses:
// from(t).update(v)/.insert(v) then .eq/.neq/.is/.select/.single, awaited.
function fakeSupabase(
  claimRows: unknown[],
  opts: {
    itemsInsertFails?: boolean;
    remindersInsertFails?: boolean;
    // Row the post-claim item_reminders read resolves to (null = none found).
    liveReminder?: { remind_at: string; anchor_at: string | null } | null;
  } = {}
) {
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
        if (opts.itemsInsertFails) {
          return { data: null, error: { message: "insert boom" } };
        }
        return { data: { id: "new-item-1" }, error: null };
      }
      if (table === "item_reminders" && op === "insert" && opts.remindersInsertFails) {
        return { data: null, error: { message: "reminder boom" } };
      }
      if (table === "item_reminders" && op === "select") {
        return { data: opts.liveReminder ?? null, error: null };
      }
      return { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
      neq: (c: string, v: unknown) => { rec.filters.push(`neq:${c}=${v}`); return chain; },
      is: (c: string, v: unknown) => { rec.filters.push(`is:${c}=${v}`); return chain; },
      select: () => chain,
      single: () => chain,
      order: (c: string, o: { ascending: boolean }) => { rec.filters.push(`order:${c}:${o.ascending}`); return chain; },
      limit: (n: number) => { rec.filters.push(`limit:${n}`); return chain; },
      maybeSingle: () => chain,
      then: (onOk: (r: unknown) => unknown) => Promise.resolve(result()).then(onOk),
    };
    return chain;
  };

  const client = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => make(table, "update", values),
      insert: (values: Record<string, unknown>) => make(table, "insert", values),
      select: (cols: string) => make(table, "select", { cols }),
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

  it("excludes recurring rows from the prior-occurrence soft-delete", async () => {
    // Regression: a completed reminder with text matching a parked recurring
    // grocery staple (recurring && completed) must not soft-delete the staple.
    // Its sibling, clear-completed/route.ts, carries the same
    // eq("recurring", false) guard for the identical reason — see
    // docs/superpowers/specs/2026-09-08-delete-is-final-design.md.
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    await completeRecurringItem(client, PARAMS);

    const softDelete = calls.find(
      (c) => c.table === "items" && c.op === "update" && c.values.deleted_at !== undefined
    );
    expect(softDelete).toBeDefined();
    expect(softDelete!.filters).toContain("eq:recurring=false");
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
    // Scoped to the caller's own list — mirrors the guard just added to
    // recycleItem (src/services/item-recycler.ts) for the same class of bug:
    // an id-only WHERE clause lets a cross-list itemId reach the write.
    // Not exploitable today (both callers pre-validate itemId against
    // listId before calling in), but the claim should not rely on that.
    expect(claim!.filters).toContain("eq:list_id=list-1");
  });

  it("claims before doing anything else", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    await completeRecurringItem(client, PARAMS);
    expect(calls[0].table).toBe("items");
    expect(calls[0].values.completed).toBe(true);
  });

  it("releases the claim when creating the new item fails, so a retry can heal it", async () => {
    // Regression: before this, a failed insert left the item permanently
    // completed=true with no successor. A retry's CAS would then lose (the item
    // is already completed), the route would answer 200 already-completed, and
    // the queue would dequeue it as a success — the series would die silently
    // with every layer reporting OK.
    const { calls, client } = fakeSupabase([{ id: "item-1" }], { itemsInsertFails: true });
    const out = await completeRecurringItem(client, PARAMS);

    expect(out.status).toBe("error");

    const release = calls.find(
      (c) => c.table === "items" && c.op === "update" && c.values.completed === false
    );
    expect(release).toBeDefined();
    expect(release!.filters).toContain("eq:id=item-1");
    expect(release!.filters).toContain("eq:completed=true");
    // Same list-scoping requirement as the claim above — the release is a
    // write by item id and should carry the same defence-in-depth guard.
    expect(release!.filters).toContain("eq:list_id=list-1");
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

  it("performs no reminder read when it loses the claim", async () => {
    const { calls, client } = fakeSupabase([], {
      liveReminder: { remind_at: "2099-01-01T09:30:00.000Z", anchor_at: null },
    });
    await completeRecurringItem(client, PARAMS);
    expect(calls.filter((c) => c.op === "select")).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});

// Snooze moves remind_at off the series slot and records the slot in anchor_at.
// Done must compute the successor from the anchor, read server-side, because
// the caller's remindAt is the snoozed time on the web path.
describe("completeRecurringItem series anchor", () => {
  const DAILY = { ...PARAMS, recurrence: "daily", remindAt: "2099-01-01T09:45:00.000Z" };
  const reminderInsert = (calls: Recorded[]) =>
    calls.find((c) => c.table === "item_reminders" && c.op === "insert")!;

  it("computes the next occurrence from anchor_at, not the snoozed remind_at", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }], {
      liveReminder: { anchor_at: "2099-01-01T09:00:00.000Z", remind_at: "2099-01-01T09:30:00.000Z" },
    });
    const out = await completeRecurringItem(client, DAILY);
    expect(reminderInsert(calls).values.remind_at).toBe("2099-01-02T09:00:00.000Z");
    if (out.status === "created") expect(out.nextRemindAt).toBe("2099-01-02T09:00:00.000Z");
    // The successor sits exactly on the slot, so it carries no anchor of its own.
    expect(reminderInsert(calls).values).not.toHaveProperty("anchor_at");
  });

  it("falls back to the live remind_at when anchor_at is null", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }], {
      liveReminder: { anchor_at: null, remind_at: "2099-01-01T09:30:00.000Z" },
    });
    await completeRecurringItem(client, DAILY);
    expect(reminderInsert(calls).values.remind_at).toBe("2099-01-02T09:30:00.000Z");
  });

  it("falls back to params.remindAt when no live reminder is found", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }], { liveReminder: null });
    await completeRecurringItem(client, DAILY);
    expect(reminderInsert(calls).values.remind_at).toBe("2099-01-02T09:45:00.000Z");
  });

  it("reads the live reminder after the claim, scoped to item, list, creator and not cancelled", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }], { liveReminder: null });
    await completeRecurringItem(client, DAILY);
    const read = calls.find((c) => c.table === "item_reminders" && c.op === "select");
    expect(read).toBeDefined();
    expect(calls.indexOf(read!)).toBeGreaterThan(0);
    expect(read!.filters).toContain("eq:item_id=item-1");
    expect(read!.filters).toContain("eq:list_id=list-1");
    expect(read!.filters).toContain("eq:created_by=user-1");
    expect(read!.filters).toContain("is:cancelled_at=null");
    // Newest live row, capped at 1 so maybeSingle() cannot error when a sent
    // row sits beside a recycled one (voice recycle cancels only unsent rows).
    expect(read!.filters).toContain("order:created_at:false");
    expect(read!.filters).toContain("limit:1");
  });
});

describe("completeRecurringItem reminder-insert failure", () => {
  it("soft-deletes the successor, releases the claim and reports an error", async () => {
    // Recurrence lives on the reminder row: a successor with no reminder never
    // fires and Done on it takes the non-recurring path, so the series would end
    // silently. Compensate so the retry wins the CAS and mints a clean pair.
    const { calls, client } = fakeSupabase([{ id: "item-1" }], { remindersInsertFails: true });
    const out = await completeRecurringItem(client, PARAMS);
    expect(out.status).toBe("error");

    const undo = calls.find(
      (c) => c.table === "items" && c.op === "update" && c.values.deleted_at !== undefined &&
        c.filters.includes("eq:id=new-item-1")
    );
    expect(undo).toBeDefined();
    expect(undo!.filters).toContain("eq:list_id=list-1");

    const release = calls.find(
      (c) => c.table === "items" && c.op === "update" && c.values.completed === false
    );
    expect(release).toBeDefined();
    expect(release!.filters).toContain("eq:id=item-1");
    expect(release!.filters).toContain("eq:completed=true");
    expect(release!.filters).toContain("eq:list_id=list-1");
    // Successor is removed before the claim is released, so a retry cannot race
    // a visible half-created occurrence.
    expect(calls.indexOf(undo!)).toBeLessThan(calls.indexOf(release!));
  });

  it("does not compensate when the reminder insert succeeds", async () => {
    const { calls, client } = fakeSupabase([{ id: "item-1" }]);
    await completeRecurringItem(client, PARAMS);
    expect(calls.filter((c) => c.values.completed === false)).toHaveLength(0);
    expect(calls.filter((c) => c.filters.includes("eq:id=new-item-1"))).toHaveLength(0);
  });
});
