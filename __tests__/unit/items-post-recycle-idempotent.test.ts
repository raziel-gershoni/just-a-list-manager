import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real items POST and the real recycler over an in-memory items table; auth, the
// rate limiter and the categorizer are faked. The recycle change is sent with the mutation
// id as its idempotencyKey, so a replay after a lost response can never add a second copy:
// C15 (the fallback insert when the target is gone) and C16 (text with a comma).
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown }[]; rows: ItemRow[] },
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
const KEY = "mut-1";
const params = { params: Promise.resolve({ id: "L" }) };
const post = (body: unknown) =>
  POST(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    params
  );
const recycle = (text = "milk", extra: Record<string, unknown> = { idempotencyKey: KEY }) => post({ text, recycleId: OLD, ...extra });
const completed = (text: string, over: Partial<ItemRow> = {}) =>
  itemRow({ id: OLD, text, completed: true, completed_at: "2026-10-01T00:00:00.000Z", position: 2, created_by: "u0", ...over });
const live = () => h.db.rows.filter((r) => r.list_id === "L" && !r.deleted_at);
const inserts = () => h.db.calls.filter((c) => c.op === "rpc");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST items with idempotencyKey and recycleId", () => {
  it("recycles the completed item to the top, answering like a plain recycle (201, recycled: true), and inserts nothing", async () => {
    h.db = fakeItemsTable([completed("milk"), itemRow({ id: "eggs", text: "eggs", position: 5 })]);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, completed: false, recycled: true })]);
    expect(live().find((r) => r.id === OLD)).toMatchObject({ completed: false, completed_at: null, position: 6, created_by: "u1" });
    expect(inserts()).toEqual([]);
  });

  it("a replay of the same recycle returns the item unchanged and adds nothing", async () => {
    h.db = fakeItemsTable([completed("milk"), itemRow({ id: "eggs", text: "eggs", position: 5 })]);
    expect((await recycle()).status).toBe(201);
    const afterFirst = JSON.stringify(h.db.rows);

    const res = await recycle();

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, recycled: true })]);
    expect(inserts()).toEqual([]);
    expect(JSON.stringify(h.db.rows)).toBe(afterFirst);
  });

  it("C15: a deleted target inserts the text once under the key, and a replay with the same key returns that row and inserts nothing", async () => {
    h.db = fakeItemsTable([completed("milk", { deleted_at: "2026-10-20T00:00:00.000Z" })]);

    const first = await recycle();

    expect(first.status).toBe(201);
    expect((await first.json()).items).toEqual([expect.objectContaining({ text: "milk", recycled: false })]);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values).toMatchObject({ p_text: "milk", p_idempotency_key: KEY });
    const inserted = live().find((r) => r.text === "milk")!;

    const replay = await recycle();

    expect(replay.status).toBe(200);
    expect((await replay.json()).items).toEqual([expect.objectContaining({ id: inserted.id, recycled: false })]);
    expect(inserts()).toHaveLength(1);
    expect(live().filter((r) => r.text === "milk")).toHaveLength(1);
  });

  it("C15: a target whose text was edited meanwhile inserts once, and the replay still adds nothing", async () => {
    h.db = fakeItemsTable([completed("oat milk")]);

    expect((await recycle()).status).toBe(201);
    expect((await recycle()).status).toBe(200);

    expect(inserts()).toHaveLength(1);
    expect(live().map((r) => r.text).sort()).toEqual(["milk", "oat milk"]);
  });

  it("C16: a text with a comma recycles the same row, whole", async () => {
    h.db = fakeItemsTable([completed("salt, pepper")]);

    const res = await recycle("salt, pepper");

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, text: "salt, pepper", completed: false, recycled: true })]);
    expect(inserts()).toEqual([]);
    expect(live()).toHaveLength(1);
  });

  it("answers a logged 500 and inserts nothing when the recycle check cannot read", async () => {
    const boom = { message: "connection reset" };
    const fake = fakeSupabase((c: FakeCall): FakeResult => (c.op === "select" ? { data: null, error: boom } : { data: null, error: null }));
    h.db = { client: fake.client, calls: fake.calls, rows: [] };

    const res = await recycle();

    expect(res.status).toBe(500);
    expect(h.db.calls.filter((c) => c.op === "rpc")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[items/POST] Recycle check failed (idempotent):", { listId: "L" }, expect.anything());
  });

  it("a create without a recycleId never touches the recycler (voice and typed adds are unchanged)", async () => {
    h.db = fakeItemsTable([completed("milk")]);

    const res = await post({ text: "milk", idempotencyKey: "k-typed", position: 7 });

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ recycled: false })]);
    expect(h.db.rows.find((r) => r.id === OLD)).toMatchObject({ completed: true });
    expect(inserts()).toHaveLength(1);
  });
});

describe("POST items with recycleId but no idempotencyKey (an entry queued by an older client)", () => {
  it("C16: a text with a comma recycles the same row instead of adding a segment per piece", async () => {
    h.db = fakeItemsTable([completed("salt, pepper")]);

    const res = await post({ text: "salt, pepper", recycleId: OLD });

    expect(res.status).toBe(201);
    expect((await res.json()).items).toEqual([expect.objectContaining({ id: OLD, text: "salt, pepper", recycled: true })]);
    expect(inserts()).toEqual([]);
    expect(live()).toHaveLength(1);
  });

  it("C16: a mismatch adds exactly one item with the whole text", async () => {
    h.db = fakeItemsTable([completed("salt, pepper", { deleted_at: "2026-10-20T00:00:00.000Z" })]);

    const res = await post({ text: "salt, pepper", recycleId: OLD });

    expect(res.status).toBe(201);
    expect(inserts().map((c) => (c.values as { p_text: string }).p_text)).toEqual(["salt, pepper"]);
    expect(live().map((r) => r.text)).toEqual(["salt, pepper"]);
  });

  it("a plain comma add (no recycleId) still splits into one item per piece", async () => {
    h.db = fakeItemsTable([]);

    const res = await post({ text: "milk, eggs" });

    expect(res.status).toBe(201);
    expect(inserts().map((c) => (c.values as { p_text: string }).p_text)).toEqual(["milk", "eggs"]);
  });
});
