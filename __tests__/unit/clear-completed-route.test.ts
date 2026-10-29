import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";
import { fakeSupabase } from "../helpers/fake-supabase";

// Runs the real route over an in-memory items table; auth and the rate limiter are faked.
// H11: Clear completed acts only on the completed items the user's screen showed.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { op: string; filters: string[] }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { POST } from "@/app/api/lists/[id]/items/clear-completed/route";

const SOAP = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const EGGS = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const TEA = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e04";
const params = { params: Promise.resolve({ id: "L" }) };
const clear = (body: unknown) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items/clear-completed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const done = { completed: true, completed_at: "2026-10-29T09:00:00.000Z" };
const deleted = () => h.db.rows.filter((r) => r.deleted_at).map((r) => r.id).sort();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({ id: MILK, text: "milk", ...done }),
    // The user unticked soap; that change has not reached the server yet.
    itemRow({ id: SOAP, text: "soap", ...done }),
    // A collaborator ticked eggs a moment ago; this screen never showed it as done.
    itemRow({ id: EGGS, text: "eggs", ...done }),
    itemRow({ id: TEA, text: "tea", ...done, recurring: true }),
  ]);
});

describe("POST /api/lists/[id]/items/clear-completed", () => {
  it("soft-deletes only the shown completed items, never one the screen showed as active or never showed", async () => {
    const res = await clear({ itemIds: [MILK] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1, clearedIds: [MILK] });
    expect(deleted()).toEqual([MILK]);
    expect(h.db.rows.find((r) => r.id === SOAP)?.deleted_at).toBeNull();
    expect(h.db.rows.find((r) => r.id === EGGS)?.deleted_at).toBeNull();
  });

  it("skips a shown id that no longer matches: unticked, parked recurring or already deleted", async () => {
    h.db.rows.find((r) => r.id === SOAP)!.completed = false;
    h.db.rows.find((r) => r.id === EGGS)!.deleted_at = "2026-10-29T08:00:00.000Z";

    const res = await clear({ itemIds: [MILK, SOAP, EGGS, TEA] });

    expect(await res.json()).toEqual({ cleared: 1, clearedIds: [MILK] });
    expect(h.db.rows.find((r) => r.id === TEA)?.deleted_at).toBeNull();
    expect(h.db.rows.find((r) => r.id === EGGS)?.deleted_at).toBe("2026-10-29T08:00:00.000Z");
  });

  it("never touches another list's row", async () => {
    h.db.rows.find((r) => r.id === MILK)!.list_id = "OTHER";

    const res = await clear({ itemIds: [MILK] });

    expect(await res.json()).toEqual({ cleared: 0, clearedIds: [] });
    expect(deleted()).toEqual([]);
  });

  it.each([
    ["no itemIds field", {}],
    ["an empty list", { itemIds: [] }],
    ["an unsynced temp id", { itemIds: [MILK, "temp-1-0.5"] }],
    ["more than 500 ids", { itemIds: Array.from({ length: 501 }, () => MILK) }],
  ])("answers 400 and writes nothing for %s", async (_label, body) => {
    const res = await clear(body);

    expect(res.status).toBe(400);
    expect(h.db.calls).toEqual([]);
    expect(deleted()).toEqual([]);
  });

  // C14: PostgREST puts every id of an .in() filter in the URL, so 500 ids (about 19.7 KB)
  // can pass a gateway's request-line limit. The ids go out in batches instead.
  describe("a big list", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `0b8f6c1e-2f4a-4c3b-9d1e-${String(i).padStart(12, "0")}`);
    const idsPerCall = () =>
      h.db.calls.filter((c) => c.op === "update").map((c) => c.filters.find((f) => f.startsWith("in:id="))!.slice("in:id=".length).split(","));

    it("clears 250 ids in batches of at most 100, every id once, and merges the cleared ids", async () => {
      h.db = fakeItemsTable(ids.map((id, i) => itemRow({ id, text: `item ${i}`, ...done })));

      const res = await clear({ itemIds: ids });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleared).toBe(250);
      expect([...body.clearedIds].sort()).toEqual([...ids].sort());
      const calls = idsPerCall();
      expect(calls.length).toBeGreaterThan(1);
      expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(100);
      expect(calls.flat().sort()).toEqual([...ids].sort());
      expect(deleted()).toHaveLength(250);
    });

    it("answers 500 when a later batch fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let updates = 0;
      const failing = fakeSupabase((call) => {
        if (call.op === "update" && ++updates === 2) return { data: null, error: { message: "boom" } };
        return { data: [], error: null };
      });
      h.db = { client: failing.client, calls: failing.calls, rows: [] };

      const res = await clear({ itemIds: ids });

      expect(res.status).toBe(500);
      expect(updates).toBe(2);
    });
  });
});
