import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real /api/user handlers; auth, initData validation, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({
  apiRateLimiter: {},
  checkRateLimit: async () => ({ success: true }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/telegram-auth", () => ({
  validateInitData: () => ({ id: 42, first_name: "Dana", last_name: "Levi", username: "dana", language_code: "he" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { GET, POST, PATCH } from "@/app/api/user/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
function fakeDb(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const calls = (op: string) => h.fake.calls.filter((c) => c.table === "users" && c.op === op);
const register = () =>
  POST(new NextRequest("https://app.test/api/user", { method: "POST", headers: { "x-telegram-init-data": "signed" } }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe("GET /api/user", () => {
  it("answers a logged 500, not 404, when the read fails", async () => {
    fakeDb(() => ({ data: null, error: boom }));
    const res = await GET(new NextRequest("https://app.test/api/user"));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[user/GET] User read failed:", { userId: "u1" }, boom);
  });

  it("answers 404 when there is no user row", async () => {
    fakeDb(noRow);
    const res = await GET(new NextRequest("https://app.test/api/user"));
    expect(res.status).toBe(404);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("POST /api/user", () => {
  it("answers a logged 500 and writes nothing when the lookup fails", async () => {
    fakeDb((c) => c.op === "select" ? { data: null, error: boom } : { data: { id: "u1" }, error: null });
    const res = await register();
    expect(res.status).toBe(500);
    expect(calls("insert")).toEqual([]);
    expect(calls("update")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[user/POST] User lookup failed:", { telegramId: 42 }, boom);
  });

  it("registers a new user with their Telegram language when no row exists", async () => {
    fakeDb((c) => c.op === "select" ? noRow(c) : { data: { id: "u1" }, error: null });
    const res = await register();
    expect(res.status).toBe(200);
    expect(calls("update")).toEqual([]);
    expect(calls("insert")).toHaveLength(1);
    expect(calls("insert")[0].values).toMatchObject({ telegram_id: 42, name: "Dana Levi", username: "dana", language: "he" });
  });

  it("updates an existing user and inserts nothing", async () => {
    fakeDb(() => ({ data: { id: "u1", telegram_id: 42 }, error: null }));
    const res = await register();
    expect(res.status).toBe(200);
    expect(calls("insert")).toEqual([]);
    expect(calls("update")).toHaveLength(1);
  });
});

describe("PATCH /api/user", () => {
  it("logs the failed language save", async () => {
    fakeDb(() => ({ data: null, error: boom }));
    const res = await PATCH(new NextRequest("https://app.test/api/user", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "ru" }),
    }));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[user/PATCH] Update failed:", { userId: "u1" }, boom);
  });
});
