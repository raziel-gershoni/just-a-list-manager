import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));

import { PATCH, DELETE } from "@/app/api/lists/[id]/items/route";

const params = { params: Promise.resolve({ id: "L" }) };
const ITEM = "11111111-1111-4111-8111-111111111111";
function patch(body: unknown) {
  return new NextRequest("https://app.test/api/lists/L/items", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}

beforeEach(() => {
  h.fake = null as unknown as typeof h.fake;
});

// Reminders are gone: ticking an item off is one plain UPDATE on items, in every list type.
// It used to read item_reminders (and lists, and items) first, to advance a repeating series.
describe("PATCH /api/lists/[id]/items completion", () => {
  it("a bare completion is a single update on items", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: { id: ITEM, completed: true }, error: null }
      : { data: null, error: null });

    const res = await PATCH(patch({ itemId: ITEM, completed: true }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ITEM, completed: true });
    expect(h.fake.calls).toHaveLength(1);
    const [update] = h.fake.calls;
    expect(update).toMatchObject({ table: "items", op: "update" });
    expect(update.values).toMatchObject({ completed: true });
    expect((update.values as { completed_at: unknown }).completed_at).toEqual(expect.any(String));
    expect(update.filters).toEqual(expect.arrayContaining([`eq:id=${ITEM}`, "eq:list_id=L", "is:deleted_at=null"]));
  });

  it("never reads item_reminders or lists, even if the item still has a live recurring reminder row", async () => {
    use((c) => {
      if (c.table === "item_reminders") {
        return { data: { created_by: "u1", remind_at: "2026-10-01T09:00:00Z", recurrence: "daily", is_shared: false }, error: null };
      }
      if (c.table === "lists") return { data: { type: "reminders" }, error: null };
      if (c.table === "items" && c.op === "select") return { data: { text: "call mom" }, error: null };
      if (c.table === "items" && c.op === "update") return { data: { id: ITEM, completed: true }, error: null };
      return { data: null, error: null };
    });

    const res = await PATCH(patch({ itemId: ITEM, completed: true }), params);

    expect(res.status).toBe(200);
    expect(h.fake.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
  });
});

// Guard rather than red-first: DELETE already had no reminder code (only a long comment).
// It fails if someone adds a reminder cancel, or any second query, back into the handler.
describe("DELETE /api/lists/[id]/items", () => {
  it("soft-deletes the item with one update on items and nothing else", async () => {
    use(() => ({ data: null, error: null }));

    const res = await DELETE(
      new NextRequest(`https://app.test/api/lists/L/items?itemId=${ITEM}`, { method: "DELETE" }),
      params
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.fake.calls).toHaveLength(1);
    const [update] = h.fake.calls;
    expect(update).toMatchObject({ table: "items", op: "update" });
    expect((update.values as { deleted_at: unknown }).deleted_at).toEqual(expect.any(String));
    expect(update.filters).toEqual(expect.arrayContaining([`eq:id=${ITEM}`, "eq:list_id=L"]));
  });
});
