import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real POST/DELETE /api/share/[token] handlers. Supabase, auth, rate limit and the bot
// are faked. A database failure must give a logged 500, never "invalid link" (404) or
// "list deleted" (410), and the invite token must never reach a log line.
const TOKEN = "invite-token-SECRET-123";

type Row = Record<string, unknown> | null;
type World = {
  invite: Row; inviteError: unknown;
  list: Row; listError: unknown;
  user: Row; userError: unknown;
  existing: Row; existingError: unknown;
  reinviteError: unknown;
  pendingCount: number | null; countError: unknown;
  inserted: Row; insertError: unknown;
  owner: Row; ownerError: unknown;
  requester: Row; requesterError: unknown;
  deleteError: unknown;
};

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; cols?: string; filters: string[] }[] },
  sendApprovalRequest: null as unknown as ReturnType<typeof vi.fn>,
}));

// Only "init-data" is valid; any other value stands for initData the server refuses (too old).
vi.mock("@/src/lib/telegram-auth", () => ({
  validateInitData: (initData: string) =>
    initData === "init-data" ? { id: 7, first_name: "Dana", language_code: "he" } : null,
}));
vi.mock("@/src/lib/rate-limit", () => ({
  apiRateLimiter: {},
  checkRateLimit: async () => ({ success: true }),
  getRateLimitHeaders: () => ({}),
}));
// Only the Bearer "good.jwt" signs in, as user u2; anything else is the real 401.
vi.mock("@/src/lib/api-auth", async () => {
  const { NextResponse } = await import("next/server");
  return {
    verifyUserAuth: async (req: Request) =>
      req.headers.get("Authorization") === "Bearer good.jwt"
        ? { success: true, userId: "u2", telegramUserId: 7 }
        : { success: false, response: NextResponse.json({ error: "Missing authentication" }, { status: 401 }) },
  };
});
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/bot", () => ({
  sendApprovalRequest: (...args: unknown[]) => h.sendApprovalRequest(...args),
}));

import { POST, DELETE } from "@/app/api/share/[token]/route";

const DB_DOWN = { message: "connection terminated unexpectedly", code: "08006" };

// Real .single() answers zero rows with an error (PGRST116); .maybeSingle() answers null.
function row(c: FakeCall, data: Row, error: unknown): FakeResult {
  if (error) return { data: null, error };
  if (data === null && c.filters.includes("single")) {
    return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }
  return { data, error: null };
}

let w: World;
function use(overrides: Partial<World> = {}) {
  w = {
    invite: { id: "inv1", list_id: "L1", permission: "edit", expires_at: "2999-01-01T00:00:00Z", revoked_at: null },
    inviteError: null,
    list: { id: "L1", name: "Groceries", owner_id: "u1" },
    listError: null,
    user: { id: "u2" },
    userError: null,
    existing: null,
    existingError: null,
    reinviteError: null,
    pendingCount: 0,
    countError: null,
    inserted: { id: "c-new" },
    insertError: null,
    owner: { telegram_id: 777, language: "he" },
    ownerError: null,
    requester: { name: "Dana Levi" },
    requesterError: null,
    deleteError: null,
    ...overrides,
  };
  h.fake = fakeSupabase((c) => {
    if (c.table === "invite_links") return row(c, w.invite, w.inviteError);
    if (c.table === "lists") return row(c, w.list, w.listError);
    if (c.table === "users" && c.op === "upsert") return row(c, w.user, w.userError);
    if (c.table === "users" && c.op === "select" && c.cols === "name") return row(c, w.requester, w.requesterError);
    if (c.table === "users" && c.op === "select") return row(c, w.owner, w.ownerError);
    if (c.table === "collaborators" && c.op === "select" && c.cols === "id, status") return row(c, w.existing, w.existingError);
    if (c.table === "collaborators" && c.op === "select") {
      return { data: null, error: w.countError, count: w.countError ? null : w.pendingCount };
    }
    if (c.table === "collaborators" && c.op === "update") return { data: null, error: w.reinviteError };
    // Not passed through row(): a test needs the "no row, no error" answer here.
    if (c.table === "collaborators" && c.op === "insert") return { data: w.inserted, error: w.insertError };
    if (c.table === "collaborators" && c.op === "delete") return { data: null, error: w.deleteError };
    throw new Error(`unexpected ${c.op} on ${c.table}`);
  }) as typeof h.fake;
}

const post = (headers: Record<string, string> = { "x-telegram-init-data": "init-data" }) =>
  POST(
    new NextRequest(`https://app.test/api/share/${TOKEN}`, { method: "POST", headers }),
    { params: Promise.resolve({ token: TOKEN }) }
  );
const del = () =>
  DELETE(
    new NextRequest(`https://app.test/api/share/${TOKEN}?collaboratorId=c1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer good.jwt" },
    })
  );

const ops = () => h.fake.calls.map((c) => `${c.table}:${c.op}`);
function printedLogs(): string {
  const calls = [
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ];
  return calls
    .flat()
    .map((a) => (typeof a === "string" ? a : `${JSON.stringify(a)} ${String(a)}`))
    .join("\n");
}

beforeEach(() => {
  h.sendApprovalRequest = vi.fn(async () => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// A Telegram "Reload page" reuses the launch initData, which the server refuses after 5
// minutes; the session JWT must still let the invitee ask to join (or see their request).
describe("POST /api/share/[token]: who is asking", () => {
  it("signs in with the Bearer JWT when there is no initData, without writing the user row", async () => {
    use();

    const res = await post({ Authorization: "Bearer good.jwt" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listId: "L1", listName: "Groceries", collaboratorId: "c-new", status: "pending" });
    expect(ops()).not.toContain("users:upsert");
    const nameRead = h.fake.calls.find((c) => c.table === "users" && c.cols === "name");
    expect(nameRead?.filters).toContain("eq:id=u2");
    const insert = h.fake.calls.find((c) => c.table === "collaborators" && c.op === "insert");
    expect(insert?.values).toMatchObject({ list_id: "L1", user_id: "u2", status: "pending" });
    expect(h.sendApprovalRequest).toHaveBeenCalledWith(777, "u2", "Dana Levi", "L1", "Groceries", "c-new", "he");
  });

  it("falls back to the Bearer JWT when the initData is too old", async () => {
    use({ existing: { id: "c-old", status: "pending" } });

    const res = await post({ "x-telegram-init-data": "stale-init-data", Authorization: "Bearer good.jwt" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "already_pending", listId: "L1", listName: "Groceries", collaboratorId: "c-old" });
    expect(ops()).not.toContain("users:upsert");
  });

  it("a JWT for the list's owner is still told they own it", async () => {
    use({ list: { id: "L1", name: "Groceries", owner_id: "u2" } });

    const res = await post({ Authorization: "Bearer good.jwt" });

    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe("already_approved");
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("answers a failed name read on the JWT path with a logged 500 before any write", async () => {
    use({ requester: null, requesterError: DB_DOWN });

    const res = await post({ Authorization: "Bearer good.jwt" });

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] User read failed:", { userId: "u2" }, DB_DOWN);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("a JWT whose user row is gone is 401, logged, and writes nothing", async () => {
    use({ requester: null });

    const res = await post({ Authorization: "Bearer good.jwt" });

    expect(res.status).toBe(401);
    expect(console.warn).toHaveBeenCalledWith("[Share] The signed-in user has no row:", { userId: "u2" });
    expect(ops()).not.toContain("collaborators:insert");
  });

  it.each([
    ["no credential", {}],
    ["initData that is too old", { "x-telegram-init-data": "stale-init-data" }],
    ["a refused JWT", { Authorization: "Bearer bad.jwt" }],
  ])("%s is 401 before any read", async (_label, headers) => {
    use();

    const res = await post(headers as Record<string, string>);

    expect(res.status).toBe(401);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("POST /api/share/[token]: reads", () => {
  it("answers a failed invite read with a logged 500, without the token in any log", async () => {
    use({ invite: null, inviteError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Invite read failed:", DB_DOWN);
    expect(printedLogs()).not.toContain(TOKEN);
    expect(ops()).toEqual(["invite_links:select"]);
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("still answers 404 for an invite that does not exist, and logs no error", async () => {
    use({ invite: null });

    const res = await post();

    expect(res.status).toBe(404);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers a failed list read with a logged 500, not 'list deleted'", async () => {
    use({ list: null, listError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] List read failed:", { listId: "L1" }, DB_DOWN);
    expect(ops()).not.toContain("users:upsert");
  });

  it("still answers 410 for a list that is really gone", async () => {
    use({ list: null });

    const res = await post();

    expect(res.status).toBe(410);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a failed user upsert with the telegram id before its 500", async () => {
    use({ user: null, userError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] User upsert failed:", { telegramId: 7 }, DB_DOWN);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("answers a failed collaborator-row read with a 500 before any write", async () => {
    use({ existingError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Collaborator read failed:",
      { listId: "L1", userId: "u2" },
      DB_DOWN
    );
    expect(ops()).not.toContain("collaborators:insert");
    expect(ops()).not.toContain("collaborators:update");
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/share/[token]: new and returning requesters", () => {
  it("creates a pending request and asks the owner, in the owner's language", async () => {
    use();

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listId: "L1", listName: "Groceries", collaboratorId: "c-new", status: "pending" });
    expect(h.sendApprovalRequest).toHaveBeenCalledWith(777, "u2", "Dana", "L1", "Groceries", "c-new", "he");
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("re-invites a declined requester and asks the owner again", async () => {
    use({ existing: { id: "c-old", status: "declined" } });

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listId: "L1", listName: "Groceries", collaboratorId: "c-old", status: "pending" });
    const update = h.fake.calls.find((c) => c.table === "collaborators" && c.op === "update");
    expect(update?.values).toEqual({ status: "pending", permission: "edit" });
    expect(update?.filters).toContain("eq:id=c-old");
    expect(h.sendApprovalRequest).toHaveBeenCalledWith(777, "u2", "Dana", "L1", "Groceries", "c-old", "he");
  });

  it("answers a failed re-invite update with a 500 and never asks the owner", async () => {
    use({ existing: { id: "c-old", status: "declined" }, reinviteError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Re-invite update failed:", { collaboratorId: "c-old" }, DB_DOWN);
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("fails closed with a 500 when the pending count cannot be read, and inserts nothing", async () => {
    use({ countError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[Share] Pending count read failed:", { listId: "L1" }, DB_DOWN);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("still refuses an 11th pending request with a 400", async () => {
    use({ pendingCount: 10 });

    const res = await post();

    expect(res.status).toBe(400);
    expect(ops()).not.toContain("collaborators:insert");
  });

  it("answers an insert that returns no row with a logged 500 instead of crashing", async () => {
    // No row and no error: the guard on the inserted row itself is what is tested.
    use({ inserted: null });

    const res = await post();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Accept invite error:",
      { listId: "L1", userId: "u2" },
      null
    );
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/share/[token]: the owner could not be asked (product call 2: still pending)", () => {
  it("answers 200 pending and warns when the bot could not message the owner", async () => {
    use();
    h.sendApprovalRequest = vi.fn(async () => false);

    const res = await post();

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-new" }
    );
  });

  it("answers 200 pending, logs and warns when sending throws", async () => {
    use({ existing: { id: "c-old", status: "declined" } });
    const boom = new Error("bot module failed to load");
    h.sendApprovalRequest = vi.fn(async () => {
      throw boom;
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[Share] Failed to send approval notification:", boom);
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-old" }
    );
  });

  it("logs a failed owner read and warns, without trying to send", async () => {
    use({ owner: null, ownerError: DB_DOWN });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[Share] Owner read failed:", { ownerId: "u1" }, DB_DOWN);
    expect(console.warn).toHaveBeenCalledWith(
      "[Share] Owner was not notified of the join request:",
      { listId: "L1", collaboratorId: "c-new" }
    );
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("warns about a missing owner row, without trying to send", async () => {
    use({ owner: null });

    const res = await post();

    expect(res.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith("[Share] List owner row is missing:", { ownerId: "u1" });
    expect(h.sendApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/share/[token] (cancel a pending request)", () => {
  it("deletes only the caller's own pending row and answers success", async () => {
    use();

    const res = await del();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [call] = h.fake.calls;
    expect(call.op).toBe("delete");
    expect([...call.filters].sort()).toEqual(["eq:id=c1", "eq:status=pending", "eq:user_id=u2"]);
  });

  it("answers a failed delete with a logged 500, so the page does not claim it cancelled", async () => {
    use({ deleteError: DB_DOWN });

    const res = await del();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      "[Share] Join request cancel failed:",
      { collaboratorId: "c1", userId: "u2" },
      DB_DOWN
    );
  });
});
