import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown },
  ready: vi.fn(async () => {}),
  remind: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "editor" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/bot", () => ({ sendListReady: h.ready, sendListReminder: h.remind }));

import { POST as readyPOST } from "@/app/api/lists/[id]/ready/route";
import { POST as remindPOST } from "@/app/api/lists/[id]/remind/route";

const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
const params = () => ({ params: Promise.resolve({ id: "L" }) });
const req = (path: string) => new NextRequest(`https://app.test/api/lists/L/${path}`, { method: "POST" });

// u1 (the sender) is an approved collaborator. The owner is the one to notify.
function db(collabError?: unknown) {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "lists" && c.cols === "name") return { data: { name: "Groceries" }, error: null };
    if (c.table === "lists") {
      return { data: { owner_id: "owner", users: { id: "owner", telegram_id: 1, language: "he" } }, error: null };
    }
    if (c.table === "users") return { data: { name: "Dana" }, error: null };
    if (c.table === "collaborators") {
      return collabError
        ? { data: null, error: collabError }
        : { data: [{ user_id: "u1", users: { id: "u1", telegram_id: 2, language: "en" } }], error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.ready.mockClear();
  h.remind.mockClear();
});

describe.each([
  { name: "ready", POST: readyPOST, send: h.ready },
  { name: "remind", POST: remindPOST, send: h.remind },
])("$name route", ({ name, POST, send }) => {
  it("fails (Next answers 500) and sends nothing when the recipient lookup fails, instead of a false 200 { sent: 0 }", async () => {
    db(dbErr);
    await expect(POST(req(name), params())).rejects.toThrow("Recipient lookup failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("notifies the owner when the lookup works", async () => {
    db();
    const res = await POST(req(name), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1 });
    expect(send).toHaveBeenCalledWith(1, "he", "Dana", "Groceries", "L");
  });
});
