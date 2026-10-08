import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Runs the real route handler; auth, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  auth: { success: true, userId: "user-1" } as unknown,
  perm: { allowed: true, role: "editor" } as { allowed: boolean; role: string | null },
  permCalls: [] as unknown[][],
  updateResult: { data: [{ id: "i1" }, { id: "i2" }], error: null } as { data: unknown; error: unknown },
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
          then: (onOk: (r: unknown) => unknown) => Promise.resolve(h.updateResult).then(onOk),
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
