import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; filters: string[] }[] },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
// The initData path: a valid signature for Telegram user 42, never rate limited.
vi.mock("@/src/lib/telegram-auth", () => ({ validateInitData: () => ({ id: 42, first_name: "Dana" }) }));
vi.mock("@/src/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true, remaining: 59, reset: 0 }),
  getRateLimitHeaders: () => ({}),
}));
vi.mock("@/src/lib/jwt", () => ({ getJwtSecret: () => new TextEncoder().encode("test-secret") }));

import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";

// PostgREST answers .single() on zero rows with PGRST116, while .maybeSingle() answers null.
// The fake mimics that, so a missing row is only "normal" through .maybeSingle().
const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
const answer = (call: FakeCall, row: unknown): FakeResult =>
  row == null && call.filters.includes("single") ? { data: null, error: NO_ROW } : { data: row ?? null, error: null };
const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };

function setFake(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const initDataReq = () =>
  new NextRequest("https://app.test/api/lists", { headers: { "x-telegram-init-data": "signed" } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("verifyUserAuth (initData path) user lookup", () => {
  it("answers 500 and logs the error when the user read fails, not 'open the app first'", async () => {
    setFake(() => ({ data: null, error: dbErr }));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth.success).toBe(false);
    if (auth.success) return;
    expect(auth.response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[items-create] User lookup failed:", { telegramUserId: 42 }, dbErr);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("User not found"));
  });

  it("keeps the 404 and the warning for a user who has no row", async () => {
    setFake((c) => answer(c, null));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth.success).toBe(false);
    if (auth.success) return;
    expect(auth.response.status).toBe(404);
    expect(console.warn).toHaveBeenCalledWith("[items-create] User not found: 42");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns the user when the row is found", async () => {
    const user = { id: "u1", telegram_id: 42, name: "Dana", username: null, language: "he" };
    setFake((c) => answer(c, user));
    const auth = await verifyUserAuth(initDataReq(), {} as never, "items-create");
    expect(auth).toEqual({ success: true, userId: "u1", telegramUserId: 42, user });
  });
});

describe("verifyListPermission", () => {
  const LIST = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
  // The owner read (lists) and the collaborator read (collaborators), told apart by table.
  function db(opts: { list?: unknown; listError?: unknown; collab?: unknown; collabError?: unknown }) {
    setFake((c) => {
      if (c.table === "lists") return opts.listError ? { data: null, error: opts.listError } : answer(c, opts.list);
      if (c.table === "collaborators") return opts.collabError ? { data: null, error: opts.collabError } : answer(c, opts.collab);
      return { data: null, error: null };
    });
  }

  it("denies a list id that is not a uuid without touching the database (a deep link to /list/garbage stays a 403)", async () => {
    db({ list: { owner_id: "u1" } });
    expect(await verifyListPermission("u1", "garbage", "view")).toEqual({ allowed: false, role: null });
    expect(h.fake.calls).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("allows the owner", async () => {
    db({ list: { owner_id: "u1" } });
    expect(await verifyListPermission("u1", LIST, "edit")).toEqual({ allowed: true, role: "owner" });
  });

  it("throws and logs when the list read fails, so the route answers 500 instead of a false 403", async () => {
    db({ listError: dbErr });
    await expect(verifyListPermission("u1", LIST, "edit")).rejects.toThrow("Permission check failed");
    expect(console.error).toHaveBeenCalledWith("[Permission] List read failed:", { userId: "u1", listId: LIST }, dbErr);
    expect(h.fake.calls.some((c) => c.table === "collaborators")).toBe(false);
  });

  it("denies, without logging an error, when the list does not exist or was deleted", async () => {
    db({ list: null });
    expect(await verifyListPermission("u1", LIST, "view")).toEqual({ allowed: false, role: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("throws and logs when the collaborator read fails", async () => {
    db({ list: { owner_id: "owner" }, collabError: dbErr });
    await expect(verifyListPermission("u1", LIST, "view")).rejects.toThrow("Permission check failed");
    expect(console.error).toHaveBeenCalledWith("[Permission] Collaborator read failed:", { userId: "u1", listId: LIST }, dbErr);
  });

  it("denies, without logging an error, a user who is not an approved collaborator", async () => {
    db({ list: { owner_id: "owner" }, collab: null });
    expect(await verifyListPermission("u1", LIST, "view")).toEqual({ allowed: false, role: null });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("lets an edit collaborator edit, and a view collaborator only view", async () => {
    db({ list: { owner_id: "owner" }, collab: { permission: "edit", status: "approved" } });
    expect(await verifyListPermission("u1", LIST, "edit")).toEqual({ allowed: true, role: "editor" });
    db({ list: { owner_id: "owner" }, collab: { permission: "view", status: "approved" } });
    expect(await verifyListPermission("u1", LIST, "edit")).toEqual({ allowed: false, role: "viewer" });
    expect(await verifyListPermission("u1", LIST, "view")).toEqual({ allowed: true, role: "viewer" });
  });
});
