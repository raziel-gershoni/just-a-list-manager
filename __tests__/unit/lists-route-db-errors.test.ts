import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real /api/lists handlers; auth, the rate limiter and Supabase are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

import { GET, POST, PATCH, DELETE } from "@/app/api/lists/route";

const LIST = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const boom = { code: "57014", message: "canceling statement due to statement timeout" };

// PostgREST's answer to a read that matches no row: .single() reports PGRST116, .maybeSingle() null.
const noRow = (c: FakeCall): FakeResult =>
  c.filters.includes("single")
    ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
    : { data: null, error: null };

function fakeDb(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}
const calls = (table: string, op: string) => h.fake.calls.filter((c) => c.table === table && c.op === op);
const json = (method: string, body: unknown) =>
  new NextRequest("https://app.test/api/lists", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

// The home screen is built from six reads: the user's lists, their collaborator rows, the
// lists shared with them, item counts, which owned lists are shared, and their per-user state.
type Read = "owned" | "collaborators" | "sharedLists" | "counts" | "sharedFlags" | "state";
const row = (id: string, owner: string) => ({
  id, name: id, owner_id: owner, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
  type: "regular", icon: null, color: null,
});
const answers: Record<Read, unknown> = {
  owned: [row("O1", "u1")],
  collaborators: [{ list_id: "S1", permission: "edit" }],
  sharedLists: [row("S1", "u2")],
  counts: [
    { list_id: "O1", active_count: "3", completed_count: "1" },
    { list_id: "S1", active_count: "2", completed_count: "0" },
  ],
  sharedFlags: [{ list_id: "O1" }],
  state: [],
};
function readOf(c: FakeCall): Read {
  if (c.table === "get_list_item_counts") return "counts";
  if (c.table === "user_list_state") return "state";
  if (c.table === "lists") return c.filters.includes("eq:owner_id=u1") ? "owned" : "sharedLists";
  return c.filters.includes("eq:user_id=u1") ? "collaborators" : "sharedFlags";
}
function home(fail?: Read) {
  fakeDb((c) => {
    const read = readOf(c);
    return read === fail ? { data: null, error: boom } : { data: answers[read], error: null };
  });
}
type HomeList = { id: string; role: string; is_shared: boolean; active_count: number; completed_count: number };
const getLists = async () => {
  const res = await GET(new NextRequest("https://app.test/api/lists"));
  return { res, body: res.status === 200 ? ((await res.json()) as HomeList[]) : [] };
};

describe("GET /api/lists", () => {
  it("answers every list with its counts and shared badge when all reads succeed", async () => {
    home();
    const { res, body } = await getLists();
    expect(res.status).toBe(200);
    expect(body.map((l) => l.id).sort()).toEqual(["O1", "S1"]);
    expect(body.find((l) => l.id === "O1")).toMatchObject({ role: "owner", is_shared: true, active_count: 3, completed_count: 1 });
    expect(body.find((l) => l.id === "S1")).toMatchObject({ role: "edit", is_shared: true, active_count: 2 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["owned", "Owned lists read"],
    ["collaborators", "Collaborator rows read"],
    ["sharedLists", "Shared lists read"],
    ["counts", "Item counts read"],
    ["state", "List state read"],
  ] as const)("answers a logged 500, not a partial home screen, when the %s read fails", async (read, what) => {
    home(read);
    const { res } = await getLists();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(`[lists/GET] ${what} failed:`, { userId: "u1" }, boom);
  });

  it("still answers 200 when only the shared-badge read fails, and warns", async () => {
    home("sharedFlags");
    const { res, body } = await getLists();
    expect(res.status).toBe(200);
    expect(body.find((l) => l.id === "O1")).toMatchObject({ is_shared: false, active_count: 3 });
    // A list shared with the user is shared by definition; it keeps its badge.
    expect(body.find((l) => l.id === "S1")).toMatchObject({ is_shared: true });
    expect(console.warn).toHaveBeenCalledWith("[lists/GET] Shared badges read failed, showing none:", { userId: "u1" }, boom);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("POST /api/lists (50-list cap)", () => {
  const create = () => POST(json("POST", { name: "Groceries" }));

  it("refuses with a logged 500 and inserts nothing when the list count cannot be read", async () => {
    fakeDb((c) => c.op === "select"
      ? ({ data: null, error: boom, count: null } as FakeResult)
      : { data: { id: LIST, name: "Groceries" }, error: null });
    const res = await create();
    expect(res.status).toBe(500);
    expect(calls("lists", "insert")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("[lists/POST] List count read failed:", { userId: "u1" }, boom);
  });

  it("creates the list when the count is under the cap", async () => {
    fakeDb((c) => c.op === "select"
      ? ({ data: null, error: null, count: 3 } as FakeResult)
      : { data: { id: LIST, name: "Groceries" }, error: null });
    const res = await create();
    expect(res.status).toBe(201);
    expect(calls("lists", "insert")).toHaveLength(1);
  });
});

describe("owner checks on undo-delete, edit and delete", () => {
  const restore = () => PATCH(json("PATCH", { id: LIST, restore: true }));
  const rename = () => PATCH(json("PATCH", { id: LIST, name: "New name" }));
  const remove = () => DELETE(new NextRequest(`https://app.test/api/lists?id=${LIST}`, { method: "DELETE" }));
  const checks = [
    ["undo delete", restore, "lists/PATCH"],
    ["edit", rename, "lists/PATCH"],
    ["delete", remove, "lists/DELETE"],
  ] as const;

  it.each(checks)("%s answers a logged 500 and writes nothing when the owner check fails", async (_label, call, tag) => {
    fakeDb((c) => c.op === "select" ? { data: null, error: boom } : { data: { id: LIST }, error: null });
    const res = await call();
    expect(res.status).toBe(500);
    expect(calls("lists", "update")).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(`[${tag}] Owner check failed:`, { listId: LIST, userId: "u1" }, boom);
  });

  it.each(checks)("%s answers 403 and writes nothing when there is no such list", async (_label, call) => {
    fakeDb((c) => c.op === "select" ? noRow(c) : { data: { id: LIST }, error: null });
    const res = await call();
    expect(res.status).toBe(403);
    expect(calls("lists", "update")).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(checks)("%s answers 403 and writes nothing for someone who is not the owner", async (_label, call) => {
    fakeDb((c) => c.op === "select" ? { data: { owner_id: "u2" }, error: null } : { data: { id: LIST }, error: null });
    expect((await call()).status).toBe(403);
    expect(calls("lists", "update")).toEqual([]);
  });

  it.each([
    ["undo delete", restore, "[lists/PATCH] Restore failed:"],
    ["edit", rename, "[lists/PATCH] Update failed:"],
    ["delete", remove, "[lists/DELETE] Delete failed:"],
  ] as const)("%s logs the failed write with its list id", async (_label, call, line) => {
    fakeDb((c) => c.op === "select" ? { data: { owner_id: "u1" }, error: null } : { data: null, error: boom });
    const res = await call();
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(line, { listId: LIST }, boom);
  });
});
