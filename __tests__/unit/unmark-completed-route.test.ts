import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";
import { fakeSupabase } from "../helpers/fake-supabase";

// Runs the real route over an in-memory items table; auth and the rate limiter are faked.
// H11: Unmark all acts only on the completed items the user's screen showed.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { table: string; op: string; filters: string[] }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { POST } from "@/app/api/lists/[id]/items/unmark-completed/route";

const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const EGGS = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const BREAD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e05";
const params = { params: Promise.resolve({ id: "L" }) };
const unmark = (body: unknown) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items/unmark-completed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const done = { completed: true, completed_at: "2026-10-29T09:00:00.000Z" };
const row = (id: string) => h.db.rows.find((r) => r.id === id)!;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({ id: MILK, text: "milk", ...done }),
    itemRow({ id: BREAD, text: "bread", ...done }),
    // A collaborator ticked eggs a moment ago; this screen never showed it as done.
    itemRow({ id: EGGS, text: "eggs", ...done }),
  ]);
});

describe("POST /api/lists/[id]/items/unmark-completed", () => {
  it("flips only the shown completed items back with a single update and does not read the lists table", async () => {
    const res = await unmark({ itemIds: [MILK, BREAD] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 2, unmarkedIds: [MILK, BREAD] });
    expect(h.db.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
    expect(row(MILK)).toMatchObject({ completed: false, completed_at: null });
    expect(row(BREAD)).toMatchObject({ completed: false, completed_at: null });
    expect(row(EGGS)).toMatchObject(done);
  });

  it("skips a shown id that is no longer completed, or deleted, or in another list", async () => {
    row(BREAD).deleted_at = "2026-10-29T08:00:00.000Z";
    row(EGGS).list_id = "OTHER";

    const res = await unmark({ itemIds: [MILK, BREAD, EGGS] });

    expect(await res.json()).toEqual({ unmarked: 1, unmarkedIds: [MILK] });
    expect(row(BREAD)).toMatchObject(done);
    expect(row(EGGS)).toMatchObject(done);
  });

  it.each([
    ["no itemIds field", {}],
    ["an empty list", { itemIds: [] }],
    ["an unsynced temp id", { itemIds: [MILK, "temp-1-0.5"] }],
    ["more than 500 ids", { itemIds: Array.from({ length: 501 }, () => MILK) }],
  ])("answers 400 and writes nothing for %s", async (_label, body) => {
    const res = await unmark(body);

    expect(res.status).toBe(400);
    expect(h.db.calls).toEqual([]);
    expect(row(MILK)).toMatchObject(done);
  });

  // C21 (server side): a parked recurring staple is not on a regular list's Completed
  // screen, so a shown-ids request that names it must not un-park it. Clear completed
  // already excludes recurring rows.
  it("never un-parks a recurring item, even when its id is in itemIds", async () => {
    row(BREAD).recurring = true;

    const res = await unmark({ itemIds: [MILK, BREAD] });

    expect(await res.json()).toEqual({ unmarked: 1, unmarkedIds: [MILK] });
    expect(row(BREAD)).toMatchObject(done);
    expect(row(MILK)).toMatchObject({ completed: false, completed_at: null });
  });

  // C14: the ids go out in batches so the PATCH URL stays short.
  describe("a big list", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `0b8f6c1e-2f4a-4c3b-9d1e-${String(i).padStart(12, "0")}`);

    it("unmarks 250 ids in batches of at most 100, every id once, and merges the unmarked ids", async () => {
      h.db = fakeItemsTable(ids.map((id, i) => itemRow({ id, text: `item ${i}`, ...done })));

      const res = await unmark({ itemIds: ids });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.unmarked).toBe(250);
      expect([...body.unmarkedIds].sort()).toEqual([...ids].sort());
      const calls = h.db.calls
        .filter((c) => c.op === "update")
        .map((c) => c.filters.find((f) => f.startsWith("in:id="))!.slice("in:id=".length).split(","));
      expect(calls.length).toBeGreaterThan(1);
      expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(100);
      expect(calls.flat().sort()).toEqual([...ids].sort());
      expect(h.db.rows.every((r) => !r.completed)).toBe(true);
    });

    it("answers 500 when a later batch fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let updates = 0;
      const failing = fakeSupabase((call) => {
        if (call.op === "update" && ++updates === 2) return { data: null, error: { message: "boom" } };
        return { data: [], error: null };
      });
      h.db = { client: failing.client, calls: failing.calls, rows: [] };

      const res = await unmark({ itemIds: ids });

      expect(res.status).toBe(500);
      expect(updates).toBe(2);
    });
  });
});
