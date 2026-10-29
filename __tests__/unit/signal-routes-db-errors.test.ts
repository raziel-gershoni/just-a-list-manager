import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real ready and remind handlers; auth, recipients, the bot and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  sendReady: vi.fn(async () => {}),
  sendReminder: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "editor" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/lib/list-notify", () => ({ resolveListRecipients: async () => [{ telegramId: 7, language: "he" }] }));
vi.mock("@/src/services/bot", () => ({ sendListReady: h.sendReady, sendListReminder: h.sendReminder }));

import { POST as READY } from "@/app/api/lists/[id]/ready/route";
import { POST as REMIND } from "@/app/api/lists/[id]/remind/route";

const boom = { code: "57014", message: "canceling statement due to statement timeout" };
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };
const list: FakeResult = { data: { name: "Groceries" }, error: null };
const sender: FakeResult = { data: { name: "Dana" }, error: null };
function use(lists: (c: FakeCall) => FakeResult, users: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase((c) => (c.table === "lists" ? lists(c) : c.table === "users" ? users(c) : { data: null, error: null })) as typeof h.fake;
}
const call = (route: typeof READY, path: string) =>
  route(new NextRequest(`https://app.test/api/lists/L/${path}`, { method: "POST" }), { params: Promise.resolve({ id: "L" }) });

beforeEach(() => {
  h.sendReady.mockClear();
  h.sendReminder.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe.each([
  ["ready", READY, h.sendReady, "Ready"],
  ["remind", REMIND, h.sendReminder, "Remind"],
] as const)("POST /api/lists/[id]/%s", (path, route, send, tag) => {
  it("answers a logged 500 and sends nothing when the list read fails", async () => {
    use(() => ({ data: null, error: boom }), () => sender);
    const res = await call(route, path);
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(`[${tag}] List read failed:`, { listId: "L" }, boom);
  });

  it("answers 404 and sends nothing when the list is gone", async () => {
    use(noRow, () => sender);
    const res = await call(route, path);
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers a logged 500 and sends nothing signed 'Someone' when the sender read fails", async () => {
    use(() => list, () => ({ data: null, error: boom }));
    const res = await call(route, path);
    expect(res.status).toBe(500);
    expect(send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(`[${tag}] Sender read failed:`, { listId: "L", userId: "u1" }, boom);
  });

  it("signs the message 'Someone' only when the sender has no row", async () => {
    use(() => list, noRow);
    const res = await call(route, path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1 });
    expect(send).toHaveBeenCalledWith(7, "he", "Someone", "Groceries", "L");
  });

  it("signs the message with the sender's name", async () => {
    use(() => list, () => sender);
    expect((await call(route, path)).status).toBe(200);
    expect(send).toHaveBeenCalledWith(7, "he", "Dana", "Groceries", "L");
  });
});
