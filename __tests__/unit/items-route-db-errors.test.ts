import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real items handlers; auth, the rate limiter, the recycler and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  after: [] as (() => unknown)[],
  recycle: vi.fn(async () => null),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("@/src/services/item-recycler", () => ({ recycleItem: h.recycle }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { GET, POST, PATCH, DELETE } from "@/app/api/lists/[id]/items/route";
import { POST as CLEAR } from "@/app/api/lists/[id]/items/clear-completed/route";
import { POST as UNMARK } from "@/app/api/lists/[id]/items/unmark-completed/route";
import { POST as UNSKIP } from "@/app/api/lists/[id]/items/unskip-all/route";

const CAT = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const ITEM = "11111111-1111-4111-8111-111111111111";
const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const params = { params: Promise.resolve({ id: "L" }) };
const req = (method: string, body?: unknown, path = "items") =>
  new NextRequest(`https://app.test/api/lists/L/${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });

// PostgREST's answer to a read that matches no row: .single() reports PGRST116, .maybeSingle() null.
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
const isLookup = (c: FakeCall) => c.table === "items" && c.op === "select" && c.filters.includes("eq:idempotency_key=k1");
const isMaxPos = (c: FakeCall) =>
  c.table === "items" && c.op === "select" && c.filters.includes("order:position:false") && c.filters.includes("limit:1");
const inserted: FakeResult = { data: [{ id: "new", text: "milk" }], error: null };

function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const inserts = () => h.fake.calls.filter((c) => c.op === "rpc" && c.table === "insert_item_if_under_limit");

beforeEach(() => {
  h.after = [];
  h.recycle.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

describe("GET /items", () => {
  it("answers a logged 500 when the items read fails", async () => {
    use((c) => c.table === "items" ? { data: null, error: boom } : { data: { type: "grocery", categories_rescan_at: null }, error: null });
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/GET] Items read failed:", { listId: "L" }, boom);
  });

  it("still returns the items, skips the sweep and warns when the list type read fails", async () => {
    use((c) => c.table === "lists" ? { data: null, error: boom } : { data: [{ id: "a", position: 1, category_id: null }], error: null });
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(h.after).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("[items/GET] List type read failed, skipping the category sweep:", { listId: "L" }, boom);
  });
});

describe("POST /items", () => {
  const create = (extra: object = {}) => POST(req("POST", { text: "milk", idempotencyKey: "k1", ...extra }), params);

  it("answers a logged 500 and inserts nothing when the duplicate check fails", async () => {
    use((c) => isLookup(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create({ position: 5 });
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Idempotency lookup failed:", { listId: "L" }, boom);
  });

  it("inserts when no item has the idempotency key yet", async () => {
    use((c) => isLookup(c) ? noRow(c) : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create({ position: 5 });
    expect(res.status).toBe(201);
    expect(inserts()).toHaveLength(1);
  });

  it("answers a logged 500 and inserts nothing when the max position cannot be read (no client position)", async () => {
    use((c) => isMaxPos(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await create();
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Max position read failed:", { listId: "L" }, boom);
  });

  it("places an item without a client position above the current top one", async () => {
    use((c) => isMaxPos(c) ? { data: [{ position: 41 }], error: null } : c.op === "rpc" ? inserted : { data: null, error: null });
    expect((await create()).status).toBe(201);
    expect(inserts()[0].values).toMatchObject({ p_position: 42 });
  });

  it("batch: answers a logged 500 and neither recycles nor inserts when the max position cannot be read", async () => {
    use((c) => isMaxPos(c) ? { data: null, error: boom } : c.op === "rpc" ? inserted : { data: null, error: null });
    const res = await POST(req("POST", { text: "milk, eggs", recycleId: MILK }), params);
    expect(res.status).toBe(500);
    expect(inserts()).toEqual([]);
    expect(h.recycle).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[items/POST] Max position read failed:", { listId: "L" }, boom);
  });
});

describe("PATCH and DELETE /items", () => {
  it("PATCH logs the failed category check", async () => {
    use((c) => c.table === "list_categories" ? { data: null, error: boom } : { data: null, error: null });
    const res = await PATCH(req("PATCH", { itemId: ITEM, categoryId: CAT }), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/PATCH] Category check failed:", { listId: "L", categoryId: CAT }, boom);
  });

  it("DELETE logs the failed soft delete", async () => {
    use(() => ({ data: null, error: boom }));
    const res = await DELETE(new NextRequest(`https://app.test/api/lists/L/items?itemId=${ITEM}`, { method: "DELETE" }), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/DELETE] Delete failed:", { listId: "L", itemId: ITEM }, boom);
  });
});

describe("bulk item routes", () => {
  it.each([
    ["clear completed", () => CLEAR(req("POST", { itemIds: [MILK] }, "items/clear-completed"), params), "[items/clear-completed/POST] Clear completed failed:"],
    ["unmark all", () => UNMARK(req("POST", { itemIds: [MILK] }, "items/unmark-completed"), params), "[items/unmark-completed/POST] Unmark completed failed:"],
    ["restore Not available", () => UNSKIP(req("POST", { itemIds: [MILK] }, "items/unskip-all"), params), "[items/unskip-all/POST] Unskip failed:"],
  ] as const)("%s answers 500 and logs the failed update with its list id", async (_label, call, line) => {
    use(() => ({ data: null, error: boom }));
    const res = await call();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(line, { listId: "L" }, boom);
  });
});
