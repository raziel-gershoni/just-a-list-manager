import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof import("../helpers/fake-supabase").fakeSupabase> }));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake!.client }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

import { GET } from "@/app/api/lists/[id]/items/route";

describe("GET /items", () => {
  it("returns each item's category so the client can group it", async () => {
    h.fake = fakeSupabase(() => ({ data: [], error: null }));
    await GET(new NextRequest("https://app.test/api/lists/l1/items?limit=500"), { params: Promise.resolve({ id: "l1" }) });

    const select = h.fake.calls.find((c) => c.table === "items" && c.op === "select")!;
    expect(select.cols).toMatch(/\bcategory_id\b/);
    expect(select.cols).toMatch(/\bcategory_locked\b/);
  });
});
