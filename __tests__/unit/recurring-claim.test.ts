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
