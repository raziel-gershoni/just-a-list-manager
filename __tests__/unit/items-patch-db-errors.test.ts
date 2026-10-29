import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: FakeCall[] },
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
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { PATCH, DELETE } from "@/app/api/lists/[id]/items/route";

const ITEM = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const TEMP = "temp-1-0.5";

const params = { params: Promise.resolve({ id: "L" }) };
function patch(body: unknown) {
  return new NextRequest("https://app.test/api/lists/L/items", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function del(itemId: string) {
  return new NextRequest(`https://app.test/api/lists/L/items?itemId=${itemId}`, { method: "DELETE" });
}
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const updates = () => h.fake.calls.filter((c) => c.table === "items" && c.op === "update");
// The post-edit reset is the update that sets only category_id = null.
const isReset = (c: FakeCall) =>
  c.table === "items" && c.op === "update" &&
  JSON.stringify(c.values) === JSON.stringify({ category_id: null });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.after = [];
  h.categorize.mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// The offline queue drops 4xx and retries 5xx. A DB error on the update must not read
// as "item not found", or the user's change is lost on the server.
describe("PATCH /api/lists/[id]/items DB failures", () => {
  it("a DB error on the update is a logged 500, so the queue retries the change", async () => {
    const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
    use((c) => c.table === "items" && c.op === "update"
      ? { data: null, error: dbErr }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: ITEM, completed: true }), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Item update failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[items/PATCH] Item update failed:",
      { listId: "L", itemId: ITEM },
      dbErr
    );
    expect(updates()).toHaveLength(1);
    expect(h.after).toEqual([]);
  });

  it("a text edit whose update fails never runs the category reset or a categorize", async () => {
    const dbErr = { message: "connection reset" };
    use((c) => c.table === "items" && c.op === "update"
      ? { data: null, error: dbErr }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: ITEM, text: "oat milk" }), params);

    expect(res.status).toBe(500);
    expect(h.fake.calls.filter(isReset)).toEqual([]);
    expect(h.after).toEqual([]);
  });

  it("an update that matches no row is a 404 with no error log", async () => {
    use(() => ({ data: null, error: null }));

    const res = await PATCH(patch({ itemId: GONE, completed: true }), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Item not found" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[items/PATCH] Item not found:", { listId: "L", itemId: GONE });
  });

  // PostgREST answers zero rows under .single() with PGRST116 as an *error*, and under
  // .maybeSingle() with { data: null, error: null }. This fake behaves the same way, so
  // a deleted row (e.g. an undo-restore of a purged item) must stay a 404 that the queue
  // drops, not a 500 it retries for 24 hours.
  it("a deleted row stays a 404, the way PostgREST reports zero rows", async () => {
    use((c) => {
      if (c.table === "items" && c.op === "update") {
        return c.filters.includes("single")
          ? { data: null, error: { code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" } }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: ITEM, deleted_at: null }), params);

    expect(res.status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a failed category reset after a text edit is a logged 500 and schedules no categorize", async () => {
    const resetErr = { message: "deadlock detected", code: "40P01" };
    use((c) => {
      if (isReset(c)) return { data: null, error: resetErr };
      if (c.table === "items" && c.op === "update") {
        return { data: { id: ITEM, text: "oat milk", category_locked: false }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: ITEM, text: "oat milk" }), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Category reset failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[items/PATCH] Category reset failed:",
      { listId: "L", itemId: ITEM },
      resetErr
    );
    expect(h.fake.calls.filter(isReset)).toHaveLength(1);
    expect(h.after).toEqual([]);
    expect(h.categorize).not.toHaveBeenCalled();
  });

  it("a successful reset after a text edit still answers 200 with the item and schedules a run", async () => {
    use((c) => {
      if (isReset(c)) return { data: null, error: null };
      if (c.table === "items" && c.op === "update") {
        return { data: { id: ITEM, text: "oat milk", category_locked: false }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: ITEM, text: "oat milk" }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ITEM, text: "oat milk" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(h.after).toHaveLength(1);
    for (const fn of h.after) await fn();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });
});

// Ruling R1. A tap on a still-pending item sends its temp-... id. PostgREST rejects it
// against the uuid column (22P02), which dbError would turn into a 500 the queue retries
// for 24 hours although it can never succeed. A 4xx before any DB call is dropped at once.
describe("a pending item's temp id", () => {
  it("PATCH answers 400 and makes no Supabase call", async () => {
    use(() => ({ data: null, error: null }));

    const res = await PATCH(patch({ itemId: TEMP, completed: true }), params);

    expect(res.status).toBe(400);
    expect(h.fake.calls).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("DELETE answers 400 with 'Invalid item id', warns naming only the list, and makes no Supabase call", async () => {
    use(() => ({ data: null, error: null }));

    const res = await DELETE(del(TEMP), params);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid item id" });
    expect(h.fake.calls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith("[items/DELETE] Invalid item id:", { listId: "L" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("DELETE with a real uuid still soft-deletes", async () => {
    use(() => ({ data: null, error: null }));

    const res = await DELETE(del(ITEM), params);

    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
  });
});
