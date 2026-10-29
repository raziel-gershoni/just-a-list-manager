import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items POST and the real recycler over an in-memory items table; auth, the
// rate limiter and the categorizer are faked. H8: a recycle (re-add from suggestions) that
// is delivered twice, by a queue replay after a lost response or by two devices tapping the
// same suggestion, must leave exactly one active row.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { table: string; op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

import { POST } from "@/app/api/lists/[id]/items/route";

const OLD = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const params = { params: Promise.resolve({ id: "L" }) };
const recycle = (body: unknown = { text: "milk", recycleId: OLD }) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const completedMilk = (over: Partial<ItemRow> = {}) =>
  itemRow({ id: OLD, text: "milk", completed: true, completed_at: "2026-10-01T00:00:00.000Z", position: 2, created_by: "u0", ...over });
const live = () => h.db.rows.filter((r) => r.list_id === "L" && !r.deleted_at);
const inserts = () => h.db.calls.filter((c) => c.op === "rpc");
const writes = () => h.db.calls.filter((c) => c.op === "update");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST items: a repeated recycle lands once", () => {
  it("the first delivery recycles the completed item to the top", async () => {
    h.db = fakeItemsTable([completedMilk(), itemRow({ id: "eggs", text: "eggs", position: 5 })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, completed: false, recycled: true })]);
    expect(live().find((r) => r.id === OLD)).toMatchObject({ completed: false, completed_at: null, position: 6, created_by: "u1" });
    expect(inserts()).toEqual([]);
  });

  it("a replay of the same recycle returns the item unchanged with 201 and writes nothing", async () => {
    h.db = fakeItemsTable([completedMilk(), itemRow({ id: "eggs", text: "eggs", position: 5 })]);
    expect((await recycle()).status).toBe(201);
    const afterFirst = JSON.stringify(h.db.rows);
    const writesAfterFirst = writes().length;

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, text: "milk", recycled: true })]);
    expect(live().filter((r) => r.text === "milk")).toHaveLength(1);
    expect(inserts()).toEqual([]);
    expect(writes()).toHaveLength(writesAfterFirst);
    expect(JSON.stringify(h.db.rows)).toBe(afterFirst);
  });

  it("a second device recycling an item another device already brought back gets that item, not a copy", async () => {
    // Device A's recycle already landed: the row is active again at the top.
    h.db = fakeItemsTable([completedMilk({ completed: false, completed_at: null, position: 9, created_by: "uA" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ position: 9, created_by: "uA" });
  });

  it("an active item whose text was changed meanwhile is not reused: the text is added as a new item", async () => {
    h.db = fakeItemsTable([completedMilk({ text: "oat milk", completed: false, completed_at: null })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ text: "milk", recycled: false })]);
    expect(live().map((r) => r.text).sort()).toEqual(["milk", "oat milk"]);
    expect(writes()).toEqual([]);
  });

  it("a deleted item stays deleted: the text is added as a new item", async () => {
    h.db = fakeItemsTable([completedMilk({ deleted_at: "2026-10-20T00:00:00.000Z" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect(h.db.rows.find((r) => r.id === OLD)).toMatchObject({ deleted_at: "2026-10-20T00:00:00.000Z", completed: true });
    expect(live().map((r) => r.text)).toEqual(["milk"]);
    expect(live()[0].id).not.toBe(OLD);
  });

  it("an id from another list is never touched, even when that item is active with the same text", async () => {
    h.db = fakeItemsTable([completedMilk({ list_id: "OTHER", completed: false, completed_at: null })]);
    const other = { ...h.db.rows[0] };

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ text: "milk", recycled: false })]);
    expect(h.db.rows[0]).toEqual(other);
    expect(live().map((r) => r.text)).toEqual(["milk"]);
  });

  it("a completed item with different text is not recycled under the request's text", async () => {
    h.db = fakeItemsTable([completedMilk({ text: "eggs" })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect(h.db.rows.find((r) => r.id === OLD)).toMatchObject({ completed: true, text: "eggs" });
    expect(live().filter((r) => !r.completed).map((r) => r.text)).toEqual(["milk"]);
  });
});
