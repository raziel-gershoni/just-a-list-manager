import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Runs the real route handler; auth, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  auth: { success: true, userId: "user-1" } as unknown,
  perm: { allowed: true, role: "editor" } as { allowed: boolean; role: string | null },
  permCalls: [] as unknown[][],
  updateResult: { data: [{ id: "i1" }, { id: "i2" }], error: null } as { data: unknown; error: unknown },
  // When set, the nth update answers updateResults[n] (then updateResult once it runs out).
  updateResults: null as null | { data: unknown; error: unknown }[],
  calls: [] as { table: string; op: string; values: unknown; filters: string[] }[],
}));

vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));

vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: vi.fn(async () => h.auth),
  verifyListPermission: vi.fn(async (...args: unknown[]) => {
    h.permCalls.push(args);
    return h.perm;
  }),
}));

vi.mock("@/src/lib/supabase", () => ({
  createServerClient: () => ({
    from: (table: string) => ({
      update: (values: unknown) => {
        const rec = { table, op: "update", values, filters: [] as string[] };
        h.calls.push(rec);
        const chain = {
          eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}=${v}`); return chain; },
          is: (c: string, v: unknown) => { rec.filters.push(`is:${c}=${v}`); return chain; },
          not: (c: string, o: string, v: unknown) => { rec.filters.push(`not:${c}:${o}:${v}`); return chain; },
          in: (c: string, v: unknown[]) => { rec.filters.push(`in:${c}=${v.join(",")}`); return chain; },
          select: (cols: string) => { rec.filters.push(`select:${cols}`); return chain; },
          then: (onOk: (r: unknown) => unknown) =>
            Promise.resolve(h.updateResults?.[h.calls.indexOf(rec)] ?? h.updateResult).then(onOk),
        };
        return chain;
      },
    }),
  }),
}));

import { POST } from "@/app/api/lists/[id]/items/unskip-all/route";

const MILK = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const EGGS = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";

function call(body: unknown = { itemIds: [MILK, EGGS] }) {
  const req = new NextRequest("https://app.test/api/lists/list-1/items/unskip-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: "list-1" }) });
}

beforeEach(() => {
  h.auth = { success: true, userId: "user-1" };
  h.perm = { allowed: true, role: "editor" };
  h.permCalls = [];
  h.updateResult = { data: [{ id: "i1" }, { id: "i2" }], error: null };
  h.calls = [];
  h.updateResults = null;
});

describe("POST /api/lists/[id]/items/unskip-all", () => {
  it("clears skipped_at on the requested items that are still Not available in this list", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 2, restoredIds: ["i1", "i2"] });
    expect(h.permCalls).toEqual([["user-1", "list-1", "edit"]]);
    expect(h.calls).toHaveLength(1);
    const [update] = h.calls;
    expect(update.table).toBe("items");
    expect(update.values).toEqual({ skipped_at: null });
    // Only the items the user saw, so a late replay can't restore what a collaborator
    // skipped after the tap. No completed/deleted filter: only skipped_at is written, and
    // an item ticked off meanwhile must not keep a stale skip that unticking would expose.
    expect([...update.filters].sort()).toEqual(
      [
        `in:id=${MILK},${EGGS}`,
        "eq:list_id=list-1",
        "not:skipped_at:is:null",
        "select:id",
      ].sort()
    );
  });

  // C14: PostgREST puts every id of an .in() filter in the URL, so a long id list goes out
  // in batches of at most 100.
  it("sends 250 ids in batches of at most 100, every id once, and merges the restored ids", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `0b8f6c1e-2f4a-4c3b-9d1e-${String(i).padStart(12, "0")}`);

    const res = await call({ itemIds: ids });

    expect(res.status).toBe(200);
    const sent = h.calls.map((c) => c.filters.find((f) => f.startsWith("in:id="))!.slice("in:id=".length).split(","));
    expect(sent.length).toBeGreaterThan(1);
    expect(Math.max(...sent.map((b) => b.length))).toBeLessThanOrEqual(100);
    expect(sent.flat().sort()).toEqual([...ids].sort());
    // The fake answers every batch with i1 and i2.
    expect(await res.json()).toEqual({ restored: 2 * sent.length, restoredIds: sent.flatMap(() => ["i1", "i2"]) });
  });

  it("answers 500 when a later batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = Array.from({ length: 250 }, (_, i) => `0b8f6c1e-2f4a-4c3b-9d1e-${String(i).padStart(12, "0")}`);
    h.updateResults = [{ data: [{ id: "i1" }], error: null }, { data: null, error: { message: "boom" } }];

    const res = await call({ itemIds: ids });

    expect(res.status).toBe(500);
    expect(h.calls).toHaveLength(2);
  });

  it("returns 403 and writes nothing for a viewer", async () => {
    h.perm = { allowed: false, role: "viewer" };

    const res = await call();

    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it("returns the auth failure response and writes nothing when the caller is not authenticated", async () => {
    h.auth = { success: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

    const res = await call();

    expect(res.status).toBe(401);
    expect(h.permCalls).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["no body field", {}],
    ["an empty list", { itemIds: [] }],
    ["an unsynced temp id", { itemIds: [MILK, "temp-1-0.5"] }],
  ])("returns 400 and writes nothing for %s", async (_label, body) => {
    const res = await call(body);

    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("returns 500 when the update fails, so the queue keeps the mutation for retry", async () => {
    h.updateResult = { data: null, error: { message: "boom" } };

    const res = await call();

    expect(res.status).toBe(500);
  });
});
