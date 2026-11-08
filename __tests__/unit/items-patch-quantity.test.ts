import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items PATCH over an in-memory items table; auth, the rate limiter and the
// categorizer are faked. A grocery item's quantity is optional free text: normalized, at most 30
// code points (like Postgres char_length), and null when there is none, never ''.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { op: string }[]; rows: ItemRow[] },
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

import { PATCH } from "@/app/api/lists/[id]/items/route";

const ITEM = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: "L" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: ITEM, ...body }),
    }),
    params
  );
const row = () => h.db.rows[0];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk", created_by: "u0" })]);
});
afterEach(() => vi.restoreAllMocks());

describe("PATCH quantity", () => {
  it("stores the normalized quantity and records who changed it", async () => {
    const res = await patch({ quantity: "  2   litres " });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ quantity: "2 litres", edited_by: "u1", text: "milk" });
  });

  it("clears it with null", async () => {
    h.db.rows[0].quantity = "3";
    await patch({ quantity: null });
    expect(row().quantity).toBe(null);
  });

  it("stores an empty or blank quantity as null, never ''", async () => {
    h.db.rows[0].quantity = "3";
    await patch({ quantity: "   " });
    expect(row().quantity).toBe(null);
  });

  it("counts characters like Postgres: 30 code points pass, 31 answer 400 and write nothing", async () => {
    const thirty = "\u{1F95B}".repeat(30); // 60 UTF-16 units, 30 code points
    expect((await patch({ quantity: thirty })).status).toBe(200);
    expect(row().quantity).toBe(thirty);
    const res = await patch({ quantity: "x".repeat(31) });
    expect(res.status).toBe(400);
    expect(row().quantity).toBe(thirty);
  });

  it("a quantity-only change is a valid update", async () => {
    const res = await patch({ quantity: "1 kg" });
    expect(res.status).not.toBe(400);
  });

  it("does not re-sort the item (only a name change resets the category)", async () => {
    const before = h.db.calls.length;
    await patch({ quantity: "2" });
    const updates = h.db.calls.slice(before).filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
  });
});
