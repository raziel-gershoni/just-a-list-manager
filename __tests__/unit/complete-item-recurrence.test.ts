import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { completeItemRespectingRecurrence } from "@/src/services/recurring";

type Recorded = {
  table: string;
  op: "update" | "insert" | "select";
  values: Record<string, unknown>;
  filters: string[];
};

type Rec = { created_by: string; remind_at: string; recurrence: string; is_shared: boolean };

// Stand-in for the PostgREST builder. Reads resolve by table (and by the select
// column list for item_reminders, which is read twice with different shapes).
function fakeSupabase(opts: {
  rec?: Rec | null;
  listType?: string | null;
  item?: { text: string } | null;
  claimRows?: unknown[];
}) {
  const calls: Recorded[] = [];
  const make = (table: string, op: Recorded["op"], values: Record<string, unknown>) => {
    const rec: Recorded = { table, op, values, filters: [] };
    calls.push(rec);
    const result = () => {
      if (op === "select") {
        if (table === "item_reminders") {
          if (String(values.cols).includes("created_by")) return { data: opts.rec ?? null, error: null };
          return { data: null, error: null }; // completeRecurringItem's post-claim read
        }
        if (table === "lists") {
          return { data: opts.listType == null ? null : { type: opts.listType }, error: null };
        }
        if (table === "items") return { data: opts.item ?? null, error: null };
      }
      if (table === "items" && op === "update" && values.completed === true) {
        return { data: opts.claimRows ?? [{ id: "item-1" }], error: null };
      }
      if (table === "items" && op === "insert") return { data: { id: "new-item-1" }, error: null };
      return { data: null, error: null };
    };
    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
      neq: (c: string, v: unknown) => { rec.filters.push(`neq:${c}=${v}`); return chain; },
      is: (c: string, v: unknown) => { rec.filters.push(`is:${c}=${v}`); return chain; },
      not: (c: string, o: string, v: unknown) => { rec.filters.push(`not:${c}:${o}:${v}`); return chain; },
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
      update: (v: Record<string, unknown>) => make(table, "update", v),
      insert: (v: Record<string, unknown>) => make(table, "insert", v),
      select: (cols: string) => make(table, "select", { cols }),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls, client: client as any };
}

const P = { itemId: "item-1", listId: "list-1" };
const REC: Rec = {
  created_by: "A",
  remind_at: "2026-09-13T04:30:00.000Z",
  recurrence: "weekly",
  is_shared: true,
};
const isClaim = (c: Recorded) => c.table === "items" && c.op === "update" && c.values.completed === true;

describe("completeItemRespectingRecurrence", () => {
  it("returns not-recurring and never claims when the item has no live recurring reminder", async () => {
    const { calls, client } = fakeSupabase({ rec: null, listType: "reminders", item: { text: "x" } });
    const out = await completeItemRespectingRecurrence(client, P);
    expect(out).toEqual({ status: "not-recurring" });
    expect(calls.filter((c) => c.table === "items" && c.op === "update")).toHaveLength(0);
    // common path stays at one query
    expect(calls).toHaveLength(1);
  });

  it("returns not-recurring and never claims when the list is not a reminders list", async () => {
    const { calls, client } = fakeSupabase({ rec: REC, listType: "grocery", item: { text: "x" } });
    const out = await completeItemRespectingRecurrence(client, P);
    expect(out).toEqual({ status: "not-recurring" });
    expect(calls.filter((c) => c.op !== "select")).toHaveLength(0);
  });

  it("returns not-recurring when the item is gone", async () => {
    const { calls, client } = fakeSupabase({ rec: REC, listType: "reminders", item: null });
    expect(await completeItemRespectingRecurrence(client, P)).toEqual({ status: "not-recurring" });
    expect(calls.filter((c) => c.op !== "select")).toHaveLength(0);
  });

  it("runs the flow as the reminder's creator, with recurrence and is_shared from the row", async () => {
    const { calls, client } = fakeSupabase({ rec: REC, listType: "reminders", item: { text: "buy milk" } });
    const out = await completeItemRespectingRecurrence(client, P);
    expect(out.status).toBe("created");
    expect(calls.some(isClaim)).toBe(true);
    const ins = calls.find((c) => c.table === "item_reminders" && c.op === "insert");
    expect(ins).toBeDefined();
    expect(ins!.values.created_by).toBe("A");
    expect(ins!.values.recurrence).toBe("weekly");
    expect(ins!.values.is_shared).toBe(true);
    const itemIns = calls.find((c) => c.table === "items" && c.op === "insert");
    expect(itemIns!.values.text).toBe("buy milk");
  });

  it("looks the reminder up by item, list, recurrence not null, live, newest first, limit 1", async () => {
    const { calls, client } = fakeSupabase({ rec: REC, listType: "reminders", item: { text: "x" } });
    await completeItemRespectingRecurrence(client, P);
    const lookup = calls[0];
    expect(lookup.table).toBe("item_reminders");
    expect(lookup.filters).toEqual(
      expect.arrayContaining([
        "eq:item_id=item-1",
        "eq:list_id=list-1",
        "not:recurrence:is:null",
        "is:cancelled_at=null",
        "order:created_at:false",
        "limit:1",
      ])
    );
  });

  it("performs no write before the claim", async () => {
    const { calls, client } = fakeSupabase({ rec: REC, listType: "reminders", item: { text: "x" } });
    await completeItemRespectingRecurrence(client, P);
    const claimIdx = calls.findIndex(isClaim);
    expect(claimIdx).toBeGreaterThan(0);
    expect(calls.slice(0, claimIdx).every((c) => c.op === "select")).toBe(true);
  });

  it("creates nothing when it loses the claim", async () => {
    const { calls, client } = fakeSupabase({
      rec: REC, listType: "reminders", item: { text: "x" }, claimRows: [],
    });
    expect((await completeItemRespectingRecurrence(client, P)).status).toBe("already-completed");
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });
});

describe("PATCH /items wiring (source inspection)", () => {
  const src = readFileSync(resolve(process.cwd(), "app/api/lists/[id]/items/route.ts"), "utf8");
  const patch = src.slice(src.indexOf("export async function PATCH"), src.indexOf("export async function DELETE"));

  it("delegates only on a pure completion, before its own update", () => {
    const call = patch.indexOf("completeItemRespectingRecurrence(supabase");
    expect(call).toBeGreaterThan(-1);
    const guard = patch.indexOf("if (isPureCompletion)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
    // The guard requires completed === true and no other meaningful key.
    const guardDef = patch.slice(patch.indexOf("const isPureCompletion"), guard);
    expect(guardDef).toContain("updates.completed === true");
    expect(guardDef).toContain('k === "completed"');
    // Before any write of the plain path.
    expect(call).toBeLessThan(patch.indexOf(".update(patchData)"));
    // Only one call site.
    expect(patch.split("completeItemRespectingRecurrence(").length - 1).toBe(1);
  });

  it("maps an error outcome to 500 (so the mutation queue retries)", () => {
    const block = patch.slice(patch.indexOf("if (isPureCompletion)"), patch.indexOf(".update(patchData)"));
    const errIdx = block.indexOf('outcome.status === "error"');
    expect(errIdx).toBeGreaterThan(-1);
    const after = block.slice(errIdx, block.indexOf("not-recurring", errIdx));
    expect(after).toContain("status: 500");
  });
});
