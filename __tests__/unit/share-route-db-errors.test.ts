import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real GET /api/share handler; auth, env, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/env", () => ({ serverEnv: () => ({ NEXT_PUBLIC_BOT_USERNAME: "testbot" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { GET } from "@/app/api/share/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const collaborator = { id: "c1", user_id: "u2", permission: "edit", status: "pending", users: { name: "Dana", username: null } };
function fakeDb(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const settings = () => GET(new NextRequest("https://app.test/api/share?listId=L"));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe("GET /api/share", () => {
  it("answers the collaborators and the active link when both reads succeed", async () => {
    fakeDb((c) => c.table === "collaborators"
      ? { data: [collaborator], error: null }
      : { data: [{ token: "tok", permission: "edit", expires_at: "2026-11-05T00:00:00Z" }], error: null });
    const res = await settings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collaborators: [collaborator], activeLink: "https://t.me/testbot?start=invite_tok" });
  });

  it.each([
    ["collaborators", "Collaborators read"],
    ["invite_links", "Active link read"],
  ])("answers a logged 500, not an empty share screen, when the %s read fails", async (table, what) => {
    fakeDb((c) => c.table === table ? { data: null, error: boom } : { data: [], error: null });
    const res = await settings();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(`[share/GET] ${what} failed:`, { listId: "L" }, boom);
  });
});
