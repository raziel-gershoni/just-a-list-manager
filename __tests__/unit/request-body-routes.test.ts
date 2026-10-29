import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

// Runs the real route handlers; auth, the rate limiter, Supabase and the AI services are faked.
const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  permCalls: [] as unknown[][],
  after: [] as (() => unknown)[],
}));
vi.mock("@/src/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/src/lib/rate-limit")>()),
  apiRateLimiter: {},
}));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async (...a: unknown[]) => { h.permCalls.push(a); return { allowed: true, role: "owner" }; },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/src/lib/env")>()),
  serverEnv: () => ({ NEXT_PUBLIC_BOT_USERNAME: "test_bot" }),
}));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: vi.fn(async () => {}) }));
vi.mock("@/src/services/item-recycler", () => ({ findRecyclableItems: async () => [], recycleItem: async () => null }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { POST as listsPOST, PATCH as listsPATCH } from "@/app/api/lists/route";
import { POST as archivePOST } from "@/app/api/lists/archive/route";
import { POST as listsReorderPOST } from "@/app/api/lists/reorder/route";
import { POST as itemsReorderPOST } from "@/app/api/lists/[id]/items/reorder/route";
import { POST as itemsPOST, PATCH as itemsPATCH } from "@/app/api/lists/[id]/items/route";
import { POST as unskipAllPOST } from "@/app/api/lists/[id]/items/unskip-all/route";
import { POST as clearCompletedPOST } from "@/app/api/lists/[id]/items/clear-completed/route";
import { POST as unmarkCompletedPOST } from "@/app/api/lists/[id]/items/unmark-completed/route";
import { POST as categoriesPOST } from "@/app/api/lists/[id]/categories/route";
import { PATCH as categoryPATCH } from "@/app/api/lists/[id]/categories/[categoryId]/route";
import { PUT as categoryOrderPUT } from "@/app/api/lists/[id]/categories/order/route";
import { PATCH as userPATCH } from "@/app/api/user/route";
import { POST as sharePOST } from "@/app/api/share/route";

const LIST = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const ITEM = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const CAT = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const listCtx = { params: Promise.resolve({ id: LIST }) };
const catCtx = { params: Promise.resolve({ id: LIST, categoryId: CAT }) };
const BAD_BODY = 'SECRET_TEXT{"name":';

const raw = (method: string, body: string) =>
  new NextRequest("https://app.test/api/x", { method, headers: { "Content-Type": "application/json" }, body });

// [label, method, log tag, handler, a body that passes validation]
const ROUTES: [string, string, string, (r: NextRequest) => Promise<Response>, unknown][] = [
  ["POST /api/lists", "POST", "lists/POST", (r) => listsPOST(r), { name: "Groceries" }],
  ["PATCH /api/lists", "PATCH", "lists/PATCH", (r) => listsPATCH(r), { id: LIST, name: "Groceries" }],
  ["POST /api/lists/archive", "POST", "lists-archive", (r) => archivePOST(r), { listId: LIST, archived: true }],
  ["POST /api/lists/reorder", "POST", "lists-reorder", (r) => listsReorderPOST(r), { orderedIds: [LIST] }],
  ["POST items/reorder", "POST", "items/reorder/POST", (r) => itemsReorderPOST(r, listCtx), { orderedIds: [ITEM] }],
  ["POST items", "POST", "items/POST", (r) => itemsPOST(r, listCtx), { text: "milk" }],
  ["PATCH items", "PATCH", "items/PATCH", (r) => itemsPATCH(r, listCtx), { itemId: ITEM, completed: true }],
  ["POST items/unskip-all", "POST", "items/unskip-all/POST", (r) => unskipAllPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST items/clear-completed", "POST", "items/clear-completed/POST", (r) => clearCompletedPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST items/unmark-completed", "POST", "items/unmark-completed/POST", (r) => unmarkCompletedPOST(r, listCtx), { itemIds: [ITEM] }],
  ["POST categories", "POST", "categories/POST", (r) => categoriesPOST(r, listCtx), { name: "Pets", locale: "en" }],
  ["PATCH categories/[categoryId]", "PATCH", "categories/PATCH", (r) => categoryPATCH(r, catCtx), { name: "Pets", locale: "en" }],
  ["PUT categories/order", "PUT", "categories/order/PUT", (r) => categoryOrderPUT(r, listCtx), { orderedIds: [CAT] }],
  ["PATCH /api/user", "PATCH", "user/PATCH", (r) => userPATCH(r), { language: "he" }],
  ["POST /api/share", "POST", "share/POST", (r) => sharePOST(r), { listId: LIST }],
];

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
function use(resolve: (c: FakeCall) => FakeResult) { h.fake = fakeSupabase(resolve) as typeof h.fake; }
const logged = () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]);

beforeEach(() => {
  h.permCalls = [];
  h.after = [];
  // Every database call fails, so a valid body stops at its first read without any AI call.
  use(() => ({ data: null, error: { message: "db down" } }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a request body that is not JSON gets a 400, never a 500", () => {
  it.each(ROUTES)("%s", async (_label, method, tag, handler) => {
    const res = await handler(raw(method, BAD_BODY));

    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(`[${tag}] Could not parse request body:`, "SyntaxError");
    expect(h.fake.calls).toEqual([]);
    expect(logged()).not.toContain("SECRET");
  });

  it.each(ROUTES)("%s still accepts a JSON body", async (_label, method, _tag, handler, body) => {
    await handler(raw(method, JSON.stringify(body)));

    expect(h.fake.calls.length).toBeGreaterThan(0);
    expect(logged()).not.toContain("Could not parse request body");
  });
});

describe("POST items reads fields only off a JSON object", () => {
  it.each([
    ["a literal null", "null", "null"],
    ["a number", "42", "number"],
    ["a string", '"milk"', "string"],
  ])("answers 400 for %s", async (_label, body, kind) => {
    const res = await itemsPOST(raw("POST", body), listCtx);

    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledWith("[items/POST] Request body is not a JSON object:", kind);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("POST /api/share validates its body", () => {
  beforeEach(() => use(() => ({ data: null, error: null })));
  const share = (body: unknown) => sharePOST(raw("POST", JSON.stringify(body)));
  const inserted = () => h.fake.calls.filter((c) => c.table === "invite_links" && c.op === "insert").map((c) => c.values);

  it.each([
    ["no listId", {}],
    ["an empty listId", { listId: "" }],
    ["a listId that is not a string", { listId: 7 }],
    ["a permission that is not a string", { listId: LIST, permission: 1 }],
  ])("answers 400 for %s, before the permission check", async (_label, body) => {
    const res = await share(body);

    expect(res.status).toBe(400);
    expect(h.permCalls).toEqual([]);
    expect(h.fake.calls).toEqual([]);
  });

  it.each([
    ["no permission", {}, "edit"],
    ["view", { permission: "view" }, "view"],
    ["edit", { permission: "edit" }, "edit"],
    ["an unknown permission", { permission: "admin" }, "edit"],
  ])("creates the invite for %s", async (_label, extra, stored) => {
    const res = await share({ listId: LIST, ...extra });

    expect(res.status).toBe(201);
    expect(h.permCalls).toEqual([["u1", LIST, "edit"]]);
    expect(inserted()).toEqual([expect.objectContaining({ list_id: LIST, permission: stored, created_by: "u1" })]);
    const json = await res.json();
    expect(json.link).toBe(`https://t.me/test_bot?start=invite_${json.token}`);
  });
});
