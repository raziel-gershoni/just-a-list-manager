import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  recycle: vi.fn(),
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
  after: () => {},
}));

import { POST } from "@/app/api/lists/[id]/items/route";

const OLD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const params = { params: Promise.resolve({ id: "L" }) };
const req = (body: unknown) =>
  new NextRequest("https://app.test/api/lists/L/items", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
const recycledMilk = { id: OLD, text: "milk", completed: false, completed_at: null, deleted_at: null, position: 9 };
const inserted = () => h.fake.calls.filter((c) => c.op === "rpc").map((c) => (c.values as { p_text: string }).p_text);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.recycle.mockReset().mockResolvedValue(null);
  // The max-position read finds an empty list; the insert RPC echoes the row it was asked for.
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.op === "rpc") {
      const v = c.values as { p_text: string; p_position: number };
      return { data: [{ id: `new-${v.p_text}`, text: v.p_text, position: v.p_position }], error: null };
    }
    return { data: [], error: null };
  }) as typeof h.fake;
});

describe("POST items (batch): a failed recycle check skips the item and never inserts a duplicate", () => {
  it("skips an item whose recycle check fails, logs it, and still adds the rest", async () => {
    const boom = new Error("Recycle item lookup failed");
    h.recycle.mockImplementation(async (_id: string, _userId: string, _listId: string, text: string) => {
      if (text === "milk") throw boom;
      return null;
    });
    const res = await POST(req({ text: "milk, eggs", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["eggs"]);
    expect((await res.json()).items.map((i: { text: string }) => i.text)).toEqual(["eggs"]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("skips the item when the recycle itself fails, instead of inserting a new copy", async () => {
    const boom = new Error("Recycle update failed");
    h.recycle.mockRejectedValue(boom);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    // Nothing was written and the only item failed: a 500 the queue retries (safe, no duplicate).
    expect(res.status).toBe(500);
    expect(h.recycle).toHaveBeenCalledWith(OLD, "u1", "L", "milk");
    expect(inserted()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed, skipping item (batch):", { listId: "L" }, boom);
  });

  it("never runs the recycler for a typed add without a recycleId", async () => {
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect(h.recycle).not.toHaveBeenCalled();
    expect(inserted()).toEqual(["milk", "eggs"]);
  });

  it("answers 500 when the only item's insert fails with a non-limit error (nothing written, queue retries)", async () => {
    h.fake = fakeSupabase((c: FakeCall): FakeResult => {
      if (c.op === "rpc") return { data: null, error: { message: "connection reset" } };
      return { data: [], error: null };
    }) as typeof h.fake;
    const res = await POST(req({ text: "milk" }), params);
    expect(res.status).toBe(500);
    expect(inserted()).toEqual(["milk"]);
  });

  it("answers 201 with the one item when a two-text batch has one failure and one success", async () => {
    h.fake = fakeSupabase((c: FakeCall): FakeResult => {
      if (c.op === "rpc") {
        const v = c.values as { p_text: string; p_position: number };
        if (v.p_text === "milk") return { data: null, error: { message: "connection reset" } };
        return { data: [{ id: `new-${v.p_text}`, text: v.p_text, position: v.p_position }], error: null };
      }
      return { data: [], error: null };
    }) as typeof h.fake;
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    expect((await res.json()).items.map((i: { text: string }) => i.text)).toEqual(["eggs"]);
  });

  it("keeps 201 with the warning when every item was skipped only because of the item limit", async () => {
    h.fake = fakeSupabase((c: FakeCall): FakeResult => {
      if (c.op === "rpc") return { data: null, error: { message: "ITEM_LIMIT_REACHED" } };
      return { data: [], error: null };
    }) as typeof h.fake;
    const res = await POST(req({ text: "milk, eggs" }), params);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.items).toEqual([]);
    expect(json.warning).toContain("500-item limit");
  });

  it("returns the recycled row when the recycle succeeds", async () => {
    h.recycle.mockResolvedValue(recycledMilk);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual([]);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
  });

  it("inserts a new item when there is nothing to recycle (recycleItem answers null)", async () => {
    h.recycle.mockResolvedValue(null);
    const res = await POST(req({ text: "milk", recycleId: OLD }), params);
    expect(res.status).toBe(201);
    expect(inserted()).toEqual(["milk"]);
  });
});
