import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as {
    client: unknown;
    calls: { table: string; op: string; values?: unknown; cols?: string; filters: string[] }[];
  },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { findRecyclableItems, recycleItem, findFuzzyMatch } from "@/src/services/item-recycler";

// PostgREST answers .single() on zero rows with PGRST116; .maybeSingle() answers null.
const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
const milk = { id: "i1", text: "milk", completed: true, completed_at: "2026-10-01T00:00:00Z", deleted_at: null, position: 3 };
const ok = (data: unknown): FakeResult => ({ data, error: null });
const err = (): FakeResult => ({ data: null, error: dbErr });

// What each read or write of the recycler answers; a key left out answers like an empty table.
type World = { search?: FakeResult; lookup?: FakeResult; maxPos?: FakeResult; update?: FakeResult; fuzzy?: FakeResult };
function use(w: World) {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    const pick = (r: FakeResult | undefined, empty: unknown): FakeResult => {
      const res = r ?? { data: empty, error: null };
      return res.data == null && !res.error && c.filters.includes("single") ? { data: null, error: NO_ROW } : res;
    };
    if (c.op === "rpc") return pick(w.fuzzy, []);
    if (c.op === "update") return pick(w.update, null);
    if (c.filters.some((f) => f.startsWith("ilike:"))) return pick(w.search, []);
    if (c.cols === "list_id") return pick(w.lookup, null);
    if (c.cols === "position") return pick(w.maxPos, []);
    return { data: null, error: null };
  }) as typeof h.fake;
}
const updates = () => h.fake.calls.filter((c) => c.op === "update");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("findRecyclableItems", () => {
  it("returns the completed matches", async () => {
    use({ search: ok([milk]) });
    expect(await findRecyclableItems("L", "milk")).toEqual([milk]);
  });

  it("rejects and logs on a failed read, instead of answering 'no match' (which creates a duplicate)", async () => {
    use({ search: err() });
    await expect(findRecyclableItems("L", "milk")).rejects.toThrow("Recyclable items read failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Recyclable items read failed:", { listId: "L" }, dbErr);
  });
});

describe("findFuzzyMatch", () => {
  it("rejects when the fuzzy RPC fails and its ILIKE fallback fails too", async () => {
    use({ fuzzy: err(), search: err() });
    await expect(findFuzzyMatch("L", "milk")).rejects.toThrow("Recyclable items read failed");
  });
});

describe("recycleItem", () => {
  it("moves the item to the top and returns it", async () => {
    use({
      lookup: ok({ list_id: "L" }),
      maxPos: ok([{ position: 7 }]),
      update: ok({ ...milk, completed: false, completed_at: null, position: 8 }),
    });
    expect(await recycleItem("i1", "u1", "L")).toMatchObject({ id: "i1", position: 8 });
    expect(updates()[0].values).toMatchObject({ completed: false, position: 8, created_by: "u1" });
    expect(updates()[0].filters).toEqual(expect.arrayContaining(["eq:id=i1", "eq:list_id=L"]));
  });

  it("returns null, without logging, for an item that is not in this list", async () => {
    use({ lookup: ok(null) });
    expect(await recycleItem("i1", "u1", "L")).toBeNull();
    expect(updates()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects and logs when the lookup fails, and writes nothing", async () => {
    use({ lookup: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Recycle item lookup failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Item lookup failed:", { listId: "L", itemId: "i1" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects when the max-position read fails, instead of recycling to position 1", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Max position read failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Max position read failed:", { listId: "L" }, dbErr);
    expect(updates()).toEqual([]);
  });

  it("rejects and logs when the update fails", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: ok([{ position: 7 }]), update: err() });
    await expect(recycleItem("i1", "u1", "L")).rejects.toThrow("Recycle update failed");
    expect(console.error).toHaveBeenCalledWith("[ItemRecycler] Recycle update failed:", { listId: "L", itemId: "i1" }, dbErr);
  });

  it("returns null, without logging, when the row is gone by the time of the update", async () => {
    use({ lookup: ok({ list_id: "L" }), maxPos: ok([{ position: 7 }]), update: ok(null) });
    expect(await recycleItem("i1", "u1", "L")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});
