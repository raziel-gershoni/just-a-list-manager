import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "viewer" }),
}));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: h.find }));

import { GET } from "@/app/api/lists/[id]/items/search/route";

const params = { params: Promise.resolve({ id: "L" }) };
const req = (q: string) => new NextRequest(`https://app.test/api/lists/L/items/search?q=${q}`);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.find.mockReset().mockResolvedValue([]);
});

describe("GET items/search (legacy route)", () => {
  it("returns the matches", async () => {
    h.find.mockResolvedValue([{ id: "a", text: "milk" }]);
    const res = await GET(req("milk"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([{ id: "a", text: "milk" }]);
    expect(h.find).toHaveBeenCalledWith("L", "milk");
  });

  it("answers a recycler failure with a logged 500, not an uncaught throw", async () => {
    const boom = new Error("db down");
    h.find.mockRejectedValue(boom);
    const res = await GET(req("milk"), params);
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items/search] Recyclable items search failed:", { listId: "L" }, boom);
  });
});
