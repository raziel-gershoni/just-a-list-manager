import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeCall } from "../helpers/fake-supabase";
import { categorizeList, type CategorizeDeps } from "@/src/services/categorize-list";
import type { ItemCategorizer, CategorizeInput, Categorization } from "@/src/services/categorizer";
import type { ListLock, RerunMode } from "@/src/utils/categorize-lock";

// Building the real categorizer reads GEMINI_API_KEY; make that fail here, never call it.
vi.mock("@/src/services/categorizer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/categorizer")>()),
  getCategorizer: () => { throw new Error("GEMINI_API_KEY missing"); },
}));

// The default AI budget runs through the real checkRateLimit over these stand-in limiters.
const limits = vi.hoisted(() => {
  const answer = async () => ({ success: true, remaining: 0, reset: 0 });
  return { list: vi.fn(answer), global: vi.fn(answer), answer };
});
vi.mock("@/src/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/rate-limit")>()),
  categorizeRateLimiter: { limit: limits.list },
  categorizeGlobalRateLimiter: { limit: limits.global },
}));

type Row = { id: string; text: string; completed: boolean; category_id: string | null; category_locked: boolean; deleted_at: string | null; created_at: string };
const row = (over: Partial<Row> & { id: string; text: string }): Row => ({
  completed: false, category_id: null, category_locked: false, deleted_at: null, created_at: "2026-10-01T00:00:00Z", ...over,
});

function world(opts: {
  type?: string;
  categories?: { id: string; name_en: string; position: number }[];
  items?: Row[];
  result?: Categorization | null;
  answer?: (input: CategorizeInput) => Categorization | null | Promise<Categorization | null>;
  rescanAt?: string; // lists.categories_rescan_at: a re-scan the user asked for that has not run yet
  aiAllowed?: boolean;
  lockFree?: boolean | boolean[]; // a list answers successive acquires (one per round)
  reruns?: (RerunMode | null)[];
  listDeleted?: boolean;
  // PostgREST reports failures as { data: null, error } instead of throwing.
  failCategoriesRead?: boolean;
  failItemsRead?: boolean;
  failInsert?: boolean;
  failApply?: boolean;
  insertRefused?: string[]; // names (en) the insert RPC answers with no row, as at the cap
}) {
  const categories = opts.categories ?? [];
  // The rows the fake database holds: reads return copies, apply_item_categories writes them.
  const items = (opts.items ?? []).map((r) => ({ ...r }));
  const list: Record<string, string | null> = {
    id: "L",
    type: opts.type === undefined ? "grocery" : opts.type,
    categories_rescan_at: opts.rescanAt ?? null,
  };
  let nextCategory = 0;
  const dbError = { message: "fetch failed", code: "" };
  const fake = fakeSupabase((call: FakeCall) => {
    // A deleted list is found only by a query that does not filter out deleted lists.
    // An update writes only when every eq filter matches the row, as in Postgres.
    if (call.table === "lists" && call.op === "update") {
      const matches = call.filters.filter((f) => f.startsWith("eq:")).every((f) => {
        const [k, v] = [f.slice(3, f.indexOf("=")), f.slice(f.indexOf("=") + 1)];
        return String(list[k]) === v;
      });
      if (matches) Object.assign(list, call.values);
      return { data: null, error: null };
    }
    if (call.table === "lists" && opts.listDeleted)
      return { data: call.filters.includes("is:deleted_at=null") ? null : { ...list }, error: null };
    if (call.table === "lists") return { data: list.type ? { ...list } : null, error: null };
    if (call.table === "list_categories" && call.op === "select") {
      if (opts.failCategoriesRead) return { data: null, error: dbError };
      return { data: categories.map((c) => ({ ...c, name_he: c.name_en, name_ru: c.name_en })), error: null };
    }
    if (call.table === "insert_list_category") {
      if (opts.failInsert) return { data: null, error: dbError };
      if (opts.insertRefused?.includes((call.values as { p_name_en: string }).p_name_en)) return { data: [], error: null };
      return { data: [{ id: `new-${++nextCategory}` }], error: null };
    }
    if (call.table === "items" && call.op === "select") {
      if (opts.failItemsRead) return { data: null, error: dbError };
      return { data: items.map((r) => ({ ...r })), error: null };
    }
    // The guards of the real function: same text, not hand-placed, live, empty in pending mode.
    if (call.table === "apply_item_categories") {
      if (opts.failApply) return { data: null, error: dbError };
      const { p_assignments, p_only_null } = call.values as { p_assignments: { id: string; text: string; category_id: string }[]; p_only_null: boolean };
      for (const a of p_assignments) {
        const r = items.find((x) => x.id === a.id);
        if (!r || r.text !== a.text || r.deleted_at || (r.category_locked && r.category_id) || (p_only_null && r.category_id)) continue;
        r.category_id = a.category_id;
        r.category_locked = false;
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });
  const inputs: CategorizeInput[] = [];
  const categorizer: ItemCategorizer = {
    categorize: vi.fn(async (input: CategorizeInput) => {
      inputs.push(input);
      if (opts.answer) return opts.answer(input);
      return opts.result === undefined ? { newCategories: [], assignments: [] } : opts.result;
    }),
    translateName: vi.fn(async () => null),
  };
  const reruns = [...(opts.reruns ?? [])];
  const free = Array.isArray(opts.lockFree) ? [...opts.lockFree] : null;
  let flag: RerunMode | null = null; // set by requestRerun, read by takeRerun, like the Redis flag
  let holder: string | null = null; // one run at a time, like the Redis lock; lockFree=false is a run elsewhere
  const lock: ListLock & { requested: RerunMode[]; acquired: string[]; released: string[] } = {
    requested: [], acquired: [], released: [],
    acquire: vi.fn(async () => {
      if (holder) return null;
      if (!(free ? free.shift() ?? true : opts.lockFree ?? true)) return null;
      const token = `tok-${lock.acquired.length + 1}`;
      lock.acquired.push(token);
      holder = token;
      return token;
    }),
    release: vi.fn(async (_l: string, token: string) => {
      if (holder === token) holder = null;
      lock.released.push(token);
    }),
    requestRerun: vi.fn(async (_l: string, m: RerunMode) => {
      lock.requested.push(m);
      if (m === "rescan" || !flag) flag = m;
    }),
    takeRerun: vi.fn(async () => {
      const taken = flag ?? reruns.shift() ?? null;
      flag = null;
      return taken;
    }),
  };
  // No settle wait unless a test asks for one.
  const deps: CategorizeDeps & { supabase: typeof fake.client } = {
    supabase: fake.client, categorizer, lock, allowAiCall: async () => opts.aiAllowed ?? true, settleMs: 0,
  };
  const rpc = () => fake.calls.filter((c) => c.table === "apply_item_categories");
  const inserts = () => fake.calls.filter((c) => c.table === "insert_list_category").map((c) => c.values);
  return { fake, deps, inputs, categorizer, lock, rpc, inserts, items, list };
}

beforeEach(() => {
  limits.list.mockReset().mockImplementation(limits.answer);
  limits.global.mockReset().mockImplementation(limits.answer);
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

  it("does nothing for a deleted grocery list", async () => {
    const w = world({ listDeleted: true, items: [row({ id: "a", text: "milk" })] });
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

  it("among unlocked rows with the same text, reuses the newest one's category", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }, { id: "baking", name_en: "Baking", position: 1 }],
      items: [
        row({ id: "older", text: "cream", category_id: "baking", created_at: "2026-09-01T00:00:00Z", deleted_at: "2026-09-02T00:00:00Z" }),
        row({ id: "newer", text: "cream", category_id: "dairy", created_at: "2026-10-01T00:00:00Z", deleted_at: "2026-10-02T00:00:00Z" }),
        row({ id: "new", text: "Cream", created_at: "2026-10-05T00:00:00Z" }),
      ],
    });
    await categorizeList(w.deps, "L", "pending");
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "new", text: "Cream", category_id: "dairy" }]);
  });

  it("writes the AI's answer to the item it was asked about when other targets were reused", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }, { id: "household", name_en: "Household", position: 1 }],
      items: [
        row({ id: "old", text: "milk", category_id: "dairy", deleted_at: "2026-10-02T00:00:00Z" }),
        row({ id: "a", text: "milk" }),
        row({ id: "b", text: "soap" }),
      ],
      result: { newCategories: [], assignments: [{ i: 0, category: "c2" }] },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs[0].items).toEqual([{ i: 0, text: "soap" }]);
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([
      { id: "a", text: "milk", category_id: "dairy" },
      { id: "b", text: "soap", category_id: "household" },
    ]);
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

  it("re-sorts a hand-placed item whose category was deleted from under it", async () => {
    // A manual move can land between a category delete's unlock and its DELETE; the FK then
    // empties category_id but leaves category_locked = true. Such an item must not stay stuck.
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "a", text: "yogurt", category_locked: true, category_id: null })],
      result: { newCategories: [], assignments: [{ i: 0, category: "c1" }] },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs[0].items).toEqual([{ i: 0, text: "yogurt" }]);
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "a", text: "yogurt", category_id: "dairy" }]);
  });

  it("inserts a new category after the existing one it names, placed by the list-locked RPC", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }, { id: "dairy", name_en: "Dairy", position: 1 }],
      items: [row({ id: "a", text: "bread" })],
      result: {
        newCategories: [{ ref: "n1", en: "Bakery", he: "מאפייה", ru: "Выпечка", after: "c1" }],
        assignments: [{ i: 0, category: "n1" }],
      },
    });
    await categorizeList(w.deps, "L", "pending");

    expect(w.inserts()).toEqual([{
      p_list_id: "L", p_name_en: "Bakery", p_name_he: "מאפייה", p_name_ru: "Выпечка",
      p_created_by: null, p_placement: "after", p_after_id: "produce", p_max: 20,
    }]);
    // Positions are the RPC's job: no client-side inserts or renumbering.
    expect(w.fake.calls.filter((c) => c.table === "list_categories" && c.op !== "select")).toEqual([]);
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([{ id: "a", text: "bread", category_id: "new-1" }]);
  });

  const placements = (w: ReturnType<typeof world>) =>
    w.inserts().map((v) => { const { p_name_en, p_placement, p_after_id } = v as Record<string, unknown>; return [p_name_en, p_placement, p_after_id]; });
  const created = (refs: [string, string | null][]) => ({
    newCategories: refs.map(([ref, after]) => ({ ref, en: ref.toUpperCase(), he: ref, ru: ref, after })),
    assignments: refs.map(([ref], i) => ({ i, category: ref })),
  });
  const items = (n: number) => Array.from({ length: n }, (_, k) => row({ id: `i${k}`, text: `item ${k}` }));

  it("first scan: leading categories go first, each after the one before, keeping the AI's walk order", async () => {
    const w = world({ items: items(3), result: created([["n1", null], ["n2", null], ["n3", null]]) });
    await categorizeList(w.deps, "L", "pending");
    expect(placements(w)).toEqual([["N1", "first", null], ["N2", "after", "new-1"], ["N3", "after", "new-2"]]);
  });

  it("chains a new category after an earlier new one by its inserted id", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }, { id: "dairy", name_en: "Dairy", position: 1 }],
      items: items(2),
      result: created([["n1", "c2"], ["n2", "n1"]]),
    });
    await categorizeList(w.deps, "L", "pending");
    expect(placements(w)).toEqual([["N1", "after", "dairy"], ["N2", "after", "new-1"]]);
  });

  it("keeps the listed order when a leading category follows one chained into the leading run", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }],
      items: items(3),
      result: created([["n1", null], ["n2", "n1"], ["n3", null]]),
    });
    await categorizeList(w.deps, "L", "pending");
    expect(placements(w)).toEqual([["N1", "first", null], ["N2", "after", "new-1"], ["N3", "after", "new-2"]]);
  });

  it("puts a category whose 'after' is not a category yet last", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }],
      items: items(2),
      result: created([["n1", "n2"], ["n2", null]]),
    });
    await categorizeList(w.deps, "L", "pending");
    expect(placements(w)).toEqual([["N1", "last", null], ["N2", "first", null]]);
  });

  it("at the cap the RPC inserts nothing: that category's items stay uncategorized, later ones place without it", async () => {
    const w = world({
      categories: [{ id: "produce", name_en: "Produce", position: 0 }],
      items: [...items(4), row({ id: "p", text: "apples" })],
      insertRefused: ["N1", "N3"],
      result: {
        ...created([["n1", null], ["n2", null], ["n3", "c1"], ["n4", "n3"]]),
        assignments: [{ i: 0, category: "n1" }, { i: 1, category: "n2" }, { i: 2, category: "n3" }, { i: 3, category: "n4" }, { i: 4, category: "c1" }],
      },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(placements(w)).toEqual([["N1", "first", null], ["N2", "first", null], ["N3", "after", "produce"], ["N4", "last", null]]);
    const written = (w.rpc()[0].values as { p_assignments: { text: string; category_id: string }[] }).p_assignments;
    expect(written.map((a) => [a.text, a.category_id])).toEqual([["item 1", "new-1"], ["item 3", "new-2"], ["apples", "produce"]]);
  });

  it("sends at most 100 items per AI call: items still to buy first, then the newest", async () => {
    // A long completed history, then one old item still to buy.
    const history = Array.from({ length: 105 }, (_, k) =>
      row({ id: `h${k}`, text: `h${k}`, completed: true, created_at: new Date(Date.UTC(2026, 1, 1) + k * 60_000).toISOString() })
    );
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [...history, row({ id: "a", text: "apples", created_at: "2026-01-01T00:00:00Z" })],
      result: { newCategories: [], assignments: [{ i: 0, category: "c1" }, { i: 99, category: "c1" }] },
    });
    await categorizeList(w.deps, "L", "pending");

    const sent = w.inputs[0].items.map((it) => it.text);
    expect(sent).toHaveLength(100);
    expect(sent.slice(0, 3)).toEqual(["apples", "h104", "h103"]);
    expect(sent.at(-1)).toBe("h6"); // h0..h5, the oldest, wait for the next run
    expect((w.rpc()[0].values as { p_assignments: unknown[] }).p_assignments).toEqual([
      { id: "a", text: "apples", category_id: "dairy" },
      { id: "h6", text: "h6", category_id: "dairy" },
    ]);
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
    expect(w.fake.calls.filter((c) => c.op !== "select")).toEqual([]);
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

  it("runs again while reruns are requested, taking the lock afresh for each round", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })], reruns: ["pending", null] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(2);
    // A new expiry per round: a slow AI call cannot run the lock out across rounds.
    expect(w.lock.acquired).toEqual(["tok-1", "tok-2"]);
    expect(w.lock.released).toEqual(["tok-1", "tok-2"]);
  });

  it("runs a requested rescan as a rescan, even when the run started as pending", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "a", text: "milk", category_id: "dairy" }), row({ id: "b", text: "soap" })],
      reruns: ["rescan", null],
      result: { newCategories: [], assignments: [{ i: 0, category: "c1" }] },
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs.map((input) => input.items.map((it) => it.text))).toEqual([["soap"], ["milk", "soap"]]);
    expect(w.rpc().map((c) => (c.values as { p_only_null: boolean }).p_only_null)).toEqual([true, false]);
  });

  it("does not lose a request that lands just before the lock is released", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    const release = w.lock.release;
    // Another trigger found the lock held and left its request just before the release.
    w.lock.release = vi.fn(async (listId: string, token: string) => {
      if (w.lock.released.length === 0) await w.lock.requestRerun(listId, "rescan");
      await release(listId, token);
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(2);
  });

  it("hands the rerun to whoever took the lock between rounds", async () => {
    // Taken by another run on both the attempt and the retry.
    const w = world({ items: [row({ id: "a", text: "milk" })], lockFree: [true, false, false], reruns: ["rescan"] });
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(1);
    expect(w.lock.requested).toEqual(["rescan"]);
  });

  // Every item gets the list's first category.
  const allToFirst = (input: CategorizeInput): Categorization => ({
    newCategories: [], assignments: input.items.map((it) => ({ i: it.i, category: "c1" })),
  });
  const dairy = [{ id: "dairy", name_en: "Dairy", position: 0 }];
  const uncategorized = (w: ReturnType<typeof world>) => w.items.filter((r) => !r.category_id).map((r) => r.text);

  it("keeps taking requests for 50 s, then leaves the next one for the next run", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    let clock = 1_000_000;
    w.deps.now = () => clock;
    // Each AI call takes 10 s and every round ends with another request waiting.
    w.categorizer.categorize = vi.fn(async () => { clock += 10_000; return { newCategories: [], assignments: [] }; });
    let waiting = 20;
    w.lock.takeRerun = vi.fn(async (): Promise<RerunMode | null> => (waiting-- > 0 ? "pending" : null));
    await categorizeList(w.deps, "L", "pending");
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(5);
    // The request waiting after the fifth round, at 50 s, is not taken.
    expect(w.lock.takeRerun).toHaveBeenCalledTimes(4);
  });

  it("sorts an item added during a run's third round (three rounds used to be the cap)", async () => {
    const w = world({ categories: dairy, items: [row({ id: "a", text: "milk" })] });
    let added = 0;
    w.categorizer.categorize = vi.fn(async (input: CategorizeInput) => {
      // Someone adds an item while the AI works; its trigger finds the lock held.
      if (added < 3) {
        added++;
        w.items.push(row({ id: `n${added}`, text: `item ${added}` }));
        await categorizeList(w.deps, "L", "pending");
      }
      return allToFirst(input);
    });
    await categorizeList(w.deps, "L", "pending");
    expect(uncategorized(w)).toEqual([]);
    expect(w.categorizer.categorize).toHaveBeenCalledTimes(4);
  });

  it("a trigger that finds the lock held just as the holder finishes still gets its item sorted", async () => {
    let inAi!: () => void;
    const holderInAi = new Promise<void>((r) => { inAi = r; });
    let finishAi!: () => void;
    const aiDone = new Promise<void>((r) => { finishAi = r; });
    let calls = 0;
    const w = world({
      categories: dairy,
      items: [row({ id: "a", text: "milk" })],
      answer: async (input) => {
        if (++calls === 1) { inAi(); await aiDone; }
        return allToFirst(input);
      },
    });
    const holder = categorizeList(w.deps, "L", "pending");
    await holderInAi;
    w.items.push(row({ id: "b", text: "soap" }));
    // The holder releases and finds no request between this trigger's failed acquire and its request.
    const requestRerun = w.lock.requestRerun;
    w.lock.requestRerun = vi.fn(async (listId: string, m: RerunMode) => {
      finishAi();
      await holder;
      await requestRerun(listId, m);
    });
    await categorizeList(w.deps, "L", "pending");
    expect(uncategorized(w)).toEqual([]);
  });

  it("a trigger that gets the lock on its retry runs a re-scan another trigger left waiting", async () => {
    const w = world({
      categories: dairy,
      items: [row({ id: "a", text: "milk", category_id: "dairy" }), row({ id: "b", text: "soap" })],
      lockFree: [false, true],
      answer: allToFirst,
    });
    await w.lock.requestRerun("L", "rescan");
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs.map((input) => input.items.map((it) => it.text))).toEqual([["milk", "soap"]]);
    expect(w.rpc().map((c) => (c.values as { p_only_null: boolean }).p_only_null)).toEqual([false]);
  });

  it("a pending run waits briefly after taking the lock, so adds landing together share one AI call", async () => {
    const w = world({ categories: dairy, items: [row({ id: "a", text: "milk" })], answer: allToFirst });
    w.deps.settleMs = 30;
    const acquire = w.lock.acquire;
    w.lock.acquire = vi.fn(async (listId: string) => {
      const token = await acquire(listId);
      // The second item of a comma list lands a moment after the first one's run took the lock.
      if (token && w.lock.acquired.length === 1) setTimeout(() => w.items.push(row({ id: "b", text: "soap" })), 1);
      return token;
    });
    await categorizeList(w.deps, "L", "pending");
    expect(w.inputs.map((input) => input.items.map((it) => it.text).sort())).toEqual([["milk", "soap"]]);
    expect(uncategorized(w)).toEqual([]);
  });

  describe("a re-scan the user asked for", () => {
    const OWED = "2026-10-08T10:00:00.123+00:00";
    const sorted = () => world({
      categories: dairy,
      items: [row({ id: "a", text: "milk", category_id: "dairy" }), row({ id: "b", text: "soap" })],
      rescanAt: OWED,
      answer: allToFirst,
    });
    const owedClears = (w: ReturnType<typeof world>) => w.fake.calls.filter((c) => c.table === "lists" && c.op === "update");

    it("runs as a re-scan when the list owes one, even if the trigger asked for pending, then is cleared", async () => {
      const w = sorted();
      await categorizeList(w.deps, "L", "pending");
      expect(w.inputs.map((input) => input.items.map((it) => it.text))).toEqual([["milk", "soap"]]);
      expect(w.rpc().map((c) => (c.values as { p_only_null: boolean }).p_only_null)).toEqual([false]);
      expect(w.list.categories_rescan_at).toBeNull();
      // Compare-and-swap on the value read: a newer request is not wiped.
      expect(owedClears(w)).toHaveLength(1);
      expect(owedClears(w)[0].values).toEqual({ categories_rescan_at: null });
      expect(owedClears(w)[0].filters).toEqual(expect.arrayContaining(["eq:id=L", `eq:categories_rescan_at=${OWED}`]));
    });

    it("stays owed when the AI budget refuses it, and a later pending trigger runs it", async () => {
      const w = sorted();
      w.deps.allowAiCall = async () => false;
      await categorizeList(w.deps, "L", "rescan");
      expect(w.categorizer.categorize).not.toHaveBeenCalled();
      expect(w.list.categories_rescan_at).toBe(OWED);

      w.deps.allowAiCall = async () => true;
      await categorizeList(w.deps, "L", "pending");
      expect(w.inputs.map((input) => input.items.map((it) => it.text))).toEqual([["milk", "soap"]]);
      expect(w.list.categories_rescan_at).toBeNull();
    });

    it("stays owed when the AI call fails", async () => {
      const w = world({ categories: dairy, items: [row({ id: "a", text: "milk" })], rescanAt: OWED, result: null });
      await categorizeList(w.deps, "L", "rescan");
      expect(w.categorizer.categorize).toHaveBeenCalledTimes(1);
      expect(w.list.categories_rescan_at).toBe(OWED);
    });

    it("stays owed when the AI's answer could not be saved", async () => {
      const w = world({ categories: dairy, items: [row({ id: "a", text: "milk" })], rescanAt: OWED, answer: allToFirst, failApply: true });
      await categorizeList(w.deps, "L", "rescan");
      expect(w.categorizer.categorize).toHaveBeenCalledTimes(1);
      expect(w.list.categories_rescan_at).toBe(OWED);
    });

    it("is cleared without an AI call when there is nothing to sort", async () => {
      const w = world({
        categories: dairy,
        items: [row({ id: "a", text: "milk", category_id: "dairy", category_locked: true }), row({ id: "b", text: "gone", deleted_at: "2026-10-02T00:00:00Z" })],
        rescanAt: OWED,
      });
      await categorizeList(w.deps, "L", "pending");
      expect(w.categorizer.categorize).not.toHaveBeenCalled();
      expect(w.list.categories_rescan_at).toBeNull();
    });

    it("asked again while one runs stays owed for the next run", async () => {
      const w = sorted();
      const LATER = "2026-10-08T10:00:05.456+00:00";
      w.categorizer.categorize = vi.fn(async (input: CategorizeInput) => {
        w.list.categories_rescan_at = LATER; // a category added while the AI works
        return allToFirst(input);
      });
      await categorizeList(w.deps, "L", "pending");
      expect(w.list.categories_rescan_at).toBe(LATER);
    });

    it("is not touched by a pending run of a list that owes none", async () => {
      const w = world({ categories: dairy, items: [row({ id: "a", text: "milk" })], answer: allToFirst });
      await categorizeList(w.deps, "L", "pending");
      expect(owedClears(w)).toEqual([]);
    });
  });

  it("releases the lock when a round throws", async () => {
    const w = world({
      categories: [{ id: "dairy", name_en: "Dairy", position: 0 }],
      items: [row({ id: "old", text: "milk", category_id: "dairy" }), row({ id: "a", text: "milk" })],
    });
    w.deps.supabase = { from: w.fake.client.from, rpc: () => { throw new Error("db down"); } };
    await expect(categorizeList(w.deps, "L", "pending")).resolves.toBeUndefined();
    expect(w.lock.released).toEqual(["tok-1"]);
  });

  it("never throws", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    w.deps.supabase = { from: () => { throw new Error("db down"); }, rpc: () => { throw new Error("db down"); } };
    await expect(categorizeList(w.deps, "L", "pending")).resolves.toBeUndefined();
  });

  describe("the default AI budget", () => {
    const refused = async () => ({ success: false, remaining: 0, reset: 0 });
    const redisDown = async (): Promise<never> => { throw new Error("redis down"); };
    const withoutBudget = (w: ReturnType<typeof world>) => ({ supabase: w.deps.supabase, categorizer: w.categorizer, lock: w.lock, settleMs: 0 });

    it("calls the AI when the list's and the app-wide budgets both allow", async () => {
      const w = world({ items: [row({ id: "a", text: "milk" })] });
      await categorizeList(withoutBudget(w), "L", "pending");
      expect(w.categorizer.categorize).toHaveBeenCalledTimes(1);
      expect(limits.list).toHaveBeenCalledWith("L");
      expect(limits.global).toHaveBeenCalledWith("global");
    });

    it.each([
      ["the list's budget is spent", "list", refused],
      ["the app-wide budget is spent", "global", refused],
      ["the list's budget cannot be checked", "list", redisDown],
      ["the app-wide budget cannot be checked", "global", redisDown],
    ] as const)("skips the AI when %s", async (_label, which, answer) => {
      limits[which].mockImplementation(answer);
      const w = world({ items: [row({ id: "a", text: "milk" })] });
      await categorizeList(withoutBudget(w), "L", "pending");
      expect(w.categorizer.categorize).not.toHaveBeenCalled();
    });
  });

  it("never throws when the default categorizer cannot be built", async () => {
    const w = world({ items: [row({ id: "a", text: "milk" })] });
    const deps = { supabase: w.deps.supabase, lock: w.lock, allowAiCall: w.deps.allowAiCall, settleMs: 0 };
    await expect(categorizeList(deps, "L", "pending")).resolves.toBeUndefined();
  });
});
