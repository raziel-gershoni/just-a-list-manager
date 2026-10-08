import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall } from "../helpers/fake-supabase";
import { categorizeList } from "@/src/services/categorize-list";
import type { ItemCategorizer, CategorizeInput, Categorization } from "@/src/services/categorizer";
import type { ListLock, RerunMode } from "@/src/utils/categorize-lock";

// Building the real categorizer reads GEMINI_API_KEY; make that fail here, never call it.
vi.mock("@/src/services/categorizer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/categorizer")>()),
  getCategorizer: () => { throw new Error("GEMINI_API_KEY missing"); },
}));

type Row = { id: string; text: string; category_id: string | null; category_locked: boolean; deleted_at: string | null; created_at: string };
const row = (over: Partial<Row> & { id: string; text: string }): Row => ({
  category_id: null, category_locked: false, deleted_at: null, created_at: "2026-10-01T00:00:00Z", ...over,
});

function world(opts: {
  type?: string;
  categories?: { id: string; name_en: string; position: number }[];
  items?: Row[];
  result?: Categorization | null;
  aiAllowed?: boolean;
  lockFree?: boolean;
  reruns?: (RerunMode | null)[];
  // PostgREST reports failures as { data: null, error } instead of throwing.
  failCategoriesRead?: boolean;
  failItemsRead?: boolean;
  failInsert?: boolean;
}) {
  const categories = opts.categories ?? [];
  let nextCategory = 0;
  const dbError = { message: "fetch failed", code: "" };
  const fake = fakeSupabase((call: FakeCall) => {
    if (call.table === "lists") return { data: opts.type === undefined ? { type: "grocery" } : opts.type ? { type: opts.type } : null, error: null };
    if (call.table === "list_categories" && call.op === "select") {
      if (opts.failCategoriesRead) return { data: null, error: dbError };
      return { data: categories.map((c) => ({ ...c, name_he: c.name_en, name_ru: c.name_en })), error: null };
    }
    if (call.table === "list_categories" && call.op === "insert") {
      if (opts.failInsert) return { data: null, error: dbError };
      return { data: { id: `new-${++nextCategory}` }, error: null };
    }
    if (call.table === "items" && call.op === "select") {
      if (opts.failItemsRead) return { data: null, error: dbError };
      return { data: opts.items ?? [], error: null };
    }
    return { data: null, error: null };
  });
  const inputs: CategorizeInput[] = [];
  const categorizer: ItemCategorizer = {
    categorize: vi.fn(async (input: CategorizeInput) => { inputs.push(input); return opts.result === undefined ? { newCategories: [], assignments: [] } : opts.result; }),
    translateName: vi.fn(async () => null),
  };
  const reruns = [...(opts.reruns ?? [])];
  const lock: ListLock & { requested: RerunMode[]; released: number } = {
    requested: [], released: 0,
    acquire: vi.fn(async () => opts.lockFree ?? true),
    release: vi.fn(async () => { lock.released++; }),
    requestRerun: vi.fn(async (_l: string, m: RerunMode) => { lock.requested.push(m); }),
    takeRerun: vi.fn(async () => reruns.shift() ?? null),
  };
  const deps = { supabase: fake.client, categorizer, lock, allowAiCall: async () => opts.aiAllowed ?? true };
  const rpc = () => fake.calls.filter((c) => c.op === "rpc");
  return { fake, deps, inputs, categorizer, lock, rpc };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("categorizeList", () => {
  it("does nothing for a list that is not a grocery list", async () => {
    const w = world({ type: "regular", items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.lock.acquire).not.toHaveBeenCalled();
  });

  it("reuses the category of a known text without calling the AI", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [
        row({ id: "old", text: "Milk", category_id: "dairy", deleted_at: "2026-10-02T00:00:00Z" }),
        row({ id: "new", text: "milk" }),
      ],
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.rpc()[0].values).toEqual({
      p_list_id: "L", p_only_null: true,
      p_assignments: [{ id: "new", text: "milk", category_id: "dairy" }],
    });
  });

  it("prefers a hand-placed row over a newer AI-placed one when reusing", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }, { id: "baking", name_en: "Baking", position: 1 }],
      items: [
        row({ id: "manual", text: "cream", category_id: "baking", category_locked: true, created_at: "2026-09-01T00:00:00Z" }),
        row({ id: "ai", text: "cream", category_id: "dairy", created_at: "2026-10-01T00:00:00Z", deleted_at: "2026-10-02T00:00:00Z" }),
        row({ id: "new", text: "Cream" }),
      ],
    });
    await categorizeList(w.deps, "L", "pending");
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "new", text: "Cream", category_id: "baking" }]);
  });

  it("sends only live, unlocked, uncategorized items with categories keyed in walk order", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 1 }, { id: "produce", name_en: "Produce", position: 0 }],
      items: [
        row({ id: "a", text: "apples" }),
        row({ id: "b", text: "soap", category_id: "dairy" }),
        row({ id: "c", text: "bread", category_locked: true, category_id: "produce" }),
        row({ id: "d", text: "gone", deleted_at: "2026-10-02T00:00:00Z" }),
      ],
      result: { newCategories: [], assignments: [{ i: 0, category: "c1" }] },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs[0]).toEqual({
      categories: [{ key: "c1", name: "Produce" }, { key: "c2", name: "Dairy" }],
      items: [{ i: 0, text: "apples" }],
      allowNew: true,
      maxNew: 18,
    });
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "a", text: "apples", category_id: "produce" }]);
  });

  it("inserts new categories and renumbers positions in walk order", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }, { id: "dairy", name_en: "Dairy", position: 1 }],
      items: [row({ id: "a", text: "bread" })],
      result: {
        newCategories: [{ ref: "n1", en: "Bakery", he: "מאפייה", ru: "Выпечка", after: "c1" }],
        assignments: [{ i: 0, category: "n1" }],
      },
    });
    await categorizeList(w.deps, "L", "pending");

    const insert = w.fake.calls.find((c) => c.table === "list_categories" && c.op === "insert")!;
    expect(insert.values).toEqual({ list_id: "L", name_en: "Bakery", name_he: "מאפייה", name_ru: "Выпечка", position: 1, created_by: null });
    const moved = w.fake.calls.filter((c) => c.table === "list_categories" && c.op === "update");
    expect(moved.map((c) => [c.values, c.filters])).toEqual([[{ position: 2 }, ["eq:id=dairy", "eq:list_id=L"]]]);
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "a", text: "bread", category_id: "new-1" }]);
  });

  it("allows no new categories once the list has 20", async () => {
    const twenty = Array.from({ length: 20 }, (_, k) => ({ id: `k${k}`, name_en: `Cat ${k}`, position: k }));
    const w = world({ categories: twenty, items: [row({ id: "a", text: "x" })] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs[0].allowNew).toBe(false);
    expect(w.inputs[0].maxNew).toBe(0);
  });

  it("rescan re-sorts every live unlocked item, skips reuse and does not require the category to be empty", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [
        row({ id: "a", text: "milk", category_id: "dairy" }),
        row({ id: "b", text: "cheese", category_id: "dairy", category_locked: true }),
        row({ id: "c", text: "milk" }),
      ],
      result: { newCategories: [], assignments: [{ i: 0, category: "c1" }, { i: 1, category: "c1" }] },
    });
    await categorizeList(w.deps, "L", "rescan");
    expect(w.inputs[0].items).toEqual([{ i: 0, text: "milk" }, { i: 1, text: "milk" }]);
    expect(w.rpc()[0].values).toMatchObject({ p_only_null: false });
  });

  it("stops when the categories read fails, instead of recreating the list's categories", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "a", text: "milk", category_id: "dairy" }), row({ id: "b", text: "cheese", category_id: "dairy" })],
      failCategoriesRead: true,
      // What the AI says when it is told the list has no categories yet.
      result: {
        newCategories: [{ ref: "n1", en: "Dairy", he: "חלב", ru: "Молочное", after: null }],
        assignments: [{ i: 0, category: "n1" }, { i: 1, category: "n1" }],
      },
    });
    await categorizeList(w.deps, "L", "rescan");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.fake.calls.filter((c) => c.table === "list_categories" && c.op !== "select")).toEqual([]);
    expect(w.rpc()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("categories"), expect.objectContaining({ listId: "L" }));
  });

  it("stops and logs when the items read fails", async () => {
    const w = world({ categories: [{ id: "dairy", name_en: "Dairy", position: 0 }], failItemsRead: true });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect(w.rpc()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("items"), expect.objectContaining({ listId: "L" }));
  });

  it("logs a failed category insert and drops the assignments that needed it", async () => {
    const w = world({
      items: [row({ id: "a", text: "bread" })],
      failInsert: true,
      result: {
        newCategories: [{ ref: "n1", en: "Bakery", he: "מאפייה", ru: "Выпечка", after: null }],
        assignments: [{ i: 0, category: "n1" }],
      },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.rpc()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("insert"), expect.objectContaining({ listId: "L" }));
  });

  it("writes nothing when the AI fails", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })], result: null });
    await categorizeList(w.deps, "L", "pending");
    expect(w.rpc()).toEqual([]);
  });

  it("skips the AI when the per-list limit is spent, but still applies reuse", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "old", text: "milk", category_id: "dairy" }), row({ id: "a", text: "milk" }), row({ id: "b", text: "soap" })],
      aiAllowed: false,
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "a", text: "milk", category_id: "dairy" }]);
  });

  it("asks the lock holder to run again instead of running concurrently", async () => {
    const w = world({ lockFree: false, items: [row({ id: "a", text: "milk" })] });
    await categorizeList(w.deps, "L", "rescan");
    expect(w.lock.requested).toEqual(["rescan"]);
    expect(w.categorizer.categorize).not.toHaveBeenCalled();
  });

  it("runs again while reruns are requested, then releases the lock", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })], reruns: ["pending", null] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(2);
    expect(w.lock.released).toBe(1);
  });

  it("never throws", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    w.deps.supabase = { from: () => { throw new Error("db down"); }, rpc: () => { throw new Error("db down"); } };
    await expect(categorizeList(w.deps, "L", "pending")).resolves.toBeUndefined();
  });

  it("never throws when the default categorizer cannot be built", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    const deps = { supabase: w.deps.supabase, lock: w.lock, allowAiCall: w.deps.allowAiCall };
    await expect(categorizeList(deps, "L", "pending")).resolves.toBeUndefined();
  });
});
