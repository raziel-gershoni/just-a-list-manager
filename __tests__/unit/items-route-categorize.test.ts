import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  resolve: (() => ({ data: null, error: null })) as (c: unknown) => unknown,
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  after: [] as (() => unknown)[],
  categorize: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: h.categorize }));
// The bulk path looks for recyclable rows with .ilike(), which the fake does not record.
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { GET, POST, PATCH } from "@/app/api/lists/[id]/items/route";

const CAT = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const params = { params: Promise.resolve({ id: "L" }) };
const req = (method: string, body?: unknown) =>
  new NextRequest("https://app.test/api/lists/L/items?limit=500", {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });

function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
async function runAfter() { for (const fn of h.after) await fn(); }

beforeEach(() => {
  h.after = [];
  h.categorize.mockClear();
});

describe("items route schedules categorization", () => {
  it("GET schedules a pending sweep when an item has no category", async () => {
    use((c) => c.table === "items" ? { data: [{ id: "a", position: 1, category_id: null }], error: null } : { data: null, error: null });
    await GET(req("GET"), params);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.objectContaining({ supabase: expect.anything() }), "L", "pending");
  });

  it("GET schedules nothing when every item is categorized", async () => {
    use((c) => c.table === "items" ? { data: [{ id: "a", position: 1, category_id: "x" }], error: null } : { data: null, error: null });
    await GET(req("GET"), params);
    expect(h.after).toEqual([]);
  });

  it("POST (idempotent create) schedules a pending run after the insert", async () => {
    use((c) => {
      if (c.op === "rpc") return { data: [{ id: "new", text: "milk" }], error: null };
      return { data: null, error: null };
    });
    const res = await POST(req("POST", { text: "milk", idempotencyKey: "k1", position: 5 }), params);
    expect(res.status).toBe(201);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });

  it("POST returning an already-created item (same idempotency key) schedules nothing", async () => {
    use((c) => c.table === "items" && c.op === "select" ? { data: { id: "old", text: "milk" }, error: null } : { data: null, error: null });
    await POST(req("POST", { text: "milk", idempotencyKey: "k1", position: 5 }), params);
    expect(h.after).toEqual([]);
  });

  it("POST (comma-separated group) schedules one pending run for the new items", async () => {
    use((c) => c.op === "rpc"
      ? { data: [{ id: "new", text: "x" }], error: null }
      : { data: null, error: null });
    const res = await POST(req("POST", { text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect(h.after).toHaveLength(1);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });

  it("POST (comma-separated group) that added nothing schedules nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    use((c) => c.op === "rpc"
      ? { data: null, error: { message: "boom" } }
      : { data: null, error: null });
    await POST(req("POST", { text: "milk, eggs" }), params);
    expect(h.after).toEqual([]);
  });

  it("PATCH text on an unlocked item clears its category and schedules a run", async () => {
    use((c) => c.table === "items" && c.op === "update" && (c.values as Record<string, unknown>).text
      ? { data: { id: "a", text: "oat milk", category_locked: false }, error: null }
      : { data: null, error: null });
    await PATCH(req("PATCH", { itemId: "a", text: "oat milk" }), params);
    const clear = h.fake.calls.find((c) => c.op === "update" && (c.values as Record<string, unknown>).category_id === null)!;
    expect(clear.filters).toEqual(expect.arrayContaining(["eq:id=a", "eq:list_id=L", "eq:category_locked=false", "eq:text=oat milk"]));
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });

  it("PATCH text on a hand-placed item keeps its category", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: { id: "a", text: "oat milk", category_locked: true }, error: null }
      : { data: null, error: null });
    await PATCH(req("PATCH", { itemId: "a", text: "oat milk" }), params);
    expect(h.fake.calls.filter((c) => c.op === "update")).toHaveLength(1);
    expect(h.after).toEqual([]);
  });

  it("PATCH without a text change keeps the category", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: { id: "a", text: "milk", category_locked: false }, error: null }
      : { data: null, error: null });
    await PATCH(req("PATCH", { itemId: "a", skipped: true }), params);
    expect(h.fake.calls.filter((c) => c.op === "update")).toHaveLength(1);
    expect(h.after).toEqual([]);
  });

  it("PATCH categoryId places the item by hand", async () => {
    use((c) => {
      if (c.table === "list_categories") return { data: { id: CAT }, error: null };
      if (c.table === "items" && c.op === "update") return { data: { id: "a" }, error: null };
      return { data: null, error: null };
    });
    const res = await PATCH(req("PATCH", { itemId: "a", categoryId: CAT }), params);
    expect(res.status).toBe(200);
    const check = h.fake.calls.find((c) => c.table === "list_categories")!;
    expect(check.filters).toEqual(expect.arrayContaining([`eq:id=${CAT}`, "eq:list_id=L"]));
    const update = h.fake.calls.find((c) => c.table === "items" && c.op === "update")!;
    expect(update.values).toMatchObject({ category_id: CAT, category_locked: true });
  });

  it("PATCH categoryId from another list is rejected", async () => {
    use(() => ({ data: null, error: null }));
    const res = await PATCH(req("PATCH", { itemId: "a", categoryId: CAT }), params);
    expect(res.status).toBe(400);
    expect(h.fake.calls.filter((c) => c.table === "items" && c.op === "update")).toEqual([]);
  });
});
