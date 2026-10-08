import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  perm: { allowed: true, role: "editor" } as { allowed: boolean; role: string },
  permCalls: [] as unknown[][],
  after: [] as (() => unknown)[],
  categorize: vi.fn(async () => {}),
  translate: vi.fn(async () => ({ en: "Pets", he: "חיות", ru: "Питомцы" }) as null | { en: string; he: string; ru: string }),
  // Name translation runs through the real checkRateLimit over these stand-in limiters.
  allow: async () => ({ success: true, remaining: 0, reset: 0 }),
  translateLimit: vi.fn(),
  globalLimit: vi.fn(),
}));
vi.mock("@/src/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/src/lib/rate-limit")>()),
  apiRateLimiter: {},
  categoryTranslateRateLimiter: { limit: h.translateLimit },
  categorizeGlobalRateLimiter: { limit: h.globalLimit },
}));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async (...a: unknown[]) => { h.permCalls.push(a); return h.perm; },
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: h.categorize }));
vi.mock("@/src/services/categorizer", async (orig) => ({
  ...(await orig<typeof import("@/src/services/categorizer")>()),
  getCategorizer: () => ({ categorize: vi.fn(), translateName: h.translate }),
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { GET, POST } from "@/app/api/lists/[id]/categories/route";
import { PATCH, DELETE } from "@/app/api/lists/[id]/categories/[categoryId]/route";
import { PUT } from "@/app/api/lists/[id]/categories/order/route";

const A = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e01";
const B = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const C = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const req = (method: string, body?: unknown) =>
  new NextRequest("https://app.test/x", { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const listParams = { params: Promise.resolve({ id: "L" }) };
const catParams = { params: Promise.resolve({ id: "L", categoryId: A }) };
function use(resolve: (c: FakeCall) => FakeResult) { h.fake = fakeSupabase(resolve) as typeof h.fake; }
async function runAfter() { for (const fn of h.after) await fn(); }

beforeEach(() => {
  h.perm = { allowed: true, role: "editor" };
  h.permCalls = [];
  h.after = [];
  h.categorize.mockClear();
  h.translate.mockClear();
  h.translateLimit.mockReset().mockImplementation(h.allow);
  h.globalLimit.mockReset().mockImplementation(h.allow);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const refused = async () => ({ success: false, remaining: 0, reset: 0 });
const redisDown = async (): Promise<never> => { throw new Error("redis down"); };
// Each way the translation budget can say no: the user's, the app-wide one, or Redis down.
const budgetRefusals = [
  ["the user's translation budget is spent", "translateLimit", refused],
  ["the app-wide AI budget is spent", "globalLimit", refused],
  ["the user's translation budget cannot be checked", "translateLimit", redisDown],
  ["the app-wide AI budget cannot be checked", "globalLimit", redisDown],
] as const;

describe("GET /categories", () => {
  it("returns the list's categories in walk order to a viewer", async () => {
    h.perm = { allowed: true, role: "viewer" };
    use(() => ({ data: [{ id: A, position: 0 }], error: null }));
    const res = await GET(req("GET"), listParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: [{ id: A, position: 0 }] });
    expect(h.permCalls[0]).toEqual(["u1", "L", "view"]);
    expect(h.fake.calls[0].filters).toEqual(expect.arrayContaining(["eq:list_id=L", "order:position:true"]));
  });

  it("is refused to someone without access", async () => {
    h.perm = { allowed: false, role: null as unknown as string };
    use(() => ({ data: [{ id: A, position: 0 }], error: null }));
    expect((await GET(req("GET"), listParams)).status).toBe(403);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("POST /categories", () => {
  const row = { id: "new", list_id: "L", name_en: "Pets", name_he: "חיות מחמד", name_ru: "Питомцы", position: 4, created_by: "u1" };
  const inserting = (rows: unknown[] | null, extra?: (c: FakeCall) => FakeResult | undefined) => (c: FakeCall) =>
    extra?.(c) ?? (c.table === "insert_list_category" ? { data: rows, error: null } : { data: null, error: null });

  it("translates, keeps the typed name in the user's language, inserts it last under the list lock and owes a re-scan", async () => {
    use(inserting([row]));
    const res = await POST(req("POST", { name: "  חיות מחמד ", locale: "he" }), listParams);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ category: row });
    expect(h.translate).toHaveBeenCalledWith("חיות מחמד");
    expect(h.translateLimit).toHaveBeenCalledWith("u1");
    expect(h.globalLimit).toHaveBeenCalledWith("global");
    const [insert, owed, ...rest] = h.fake.calls;
    expect(insert).toMatchObject({ op: "rpc", table: "insert_list_category" });
    expect(insert.values).toEqual({
      p_list_id: "L", p_name_en: "Pets", p_name_he: "חיות מחמד", p_name_ru: "Питомцы",
      p_created_by: "u1", p_placement: "last", p_after_id: null, p_max: 20,
    });
    expect(owed).toMatchObject({ table: "lists", op: "update", values: { categories_rescan_at: expect.any(String) } });
    expect(Number.isNaN(Date.parse((owed.values as { categories_rescan_at: string }).categories_rescan_at))).toBe(false);
    expect(owed.filters).toEqual(["eq:id=L"]);
    expect(rest).toEqual([]);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "rescan");
  });

  it("uses the typed name everywhere when translation fails", async () => {
    h.translate.mockResolvedValueOnce(null);
    use(inserting([{ id: "new" }]));
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(201);
    expect(h.fake.calls[0].values).toMatchObject({ p_name_en: "Pets", p_name_he: "Pets", p_name_ru: "Pets" });
  });

  it.each(budgetRefusals)("adds the category under its typed name, with no AI call, when %s", async (_label, which, answer) => {
    h[which].mockImplementation(answer);
    use(inserting([{ id: "new" }]));
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(201);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.fake.calls[0].values).toMatchObject({ p_name_en: "Pets", p_name_he: "Pets", p_name_ru: "Pets" });
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "rescan");
  });

  it("refuses a 21st category: the RPC inserts nothing, and no re-scan is owed or scheduled", async () => {
    use(inserting([]));
    const res = await POST(req("POST", { name: "One more", locale: "en" }), listParams);
    expect(res.status).toBe(400);
    expect(h.fake.calls.filter((c) => c.table === "lists")).toEqual([]);
    expect(h.after).toEqual([]);
  });

  it("answers 500 and schedules nothing when the insert fails", async () => {
    use((c) => c.table === "insert_list_category" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(500);
    expect(h.fake.calls.filter((c) => c.table === "lists")).toEqual([]);
    expect(h.after).toEqual([]);
  });

  // The category exists; the re-scan still runs now, it just is not remembered if the AI fails.
  it("still answers 201 and re-scans when the owed re-scan cannot be saved", async () => {
    use(inserting([{ id: "new" }], (c) => c.table === "lists" ? { data: null, error: { message: "boom" } } : undefined));
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(201);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "rescan");
  });

  it.each([[{ name: "", locale: "en" }], [{ name: "x".repeat(41), locale: "en" }], [{ name: "ok", locale: "fr" }]])(
    "rejects %j", async (body) => {
      use(() => ({ data: [], error: null }));
      expect((await POST(req("POST", body), listParams)).status).toBe(400);
    });

  it("is refused to a viewer", async () => {
    h.perm = { allowed: false, role: "viewer" };
    use(() => ({ data: [], error: null }));
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(403);
    expect(h.fake.calls).toEqual([]);
  });
});

describe("PATCH /categories/[categoryId]", () => {
  const stored = { id: A, list_id: "L", name_en: "Pets", name_he: "חיות", name_ru: "Питомцы", position: 2, created_by: null };
  const renaming = (found: unknown, update?: FakeResult) => (c: FakeCall) =>
    c.op === "select" ? { data: found, error: null }
      : c.op === "update" ? update ?? { data: { ...stored, ...(c.values as object) }, error: null }
      : { data: null, error: null };

  it("renames all three names, keeping the typed one in the user's language", async () => {
    use(renaming(stored));
    const res = await PATCH(req("PATCH", { name: "Питомцы!", locale: "ru" }), catParams);
    expect(res.status).toBe(200);
    expect(h.translate).toHaveBeenCalledWith("Питомцы!");
    const [read, update] = h.fake.calls;
    expect(read).toMatchObject({ table: "list_categories", op: "select" });
    expect(read.filters).toEqual(expect.arrayContaining([`eq:id=${A}`, "eq:list_id=L"]));
    expect(update.values).toEqual({ name_en: "Pets", name_he: "חיות", name_ru: "Питомцы!" });
    expect(update.filters).toEqual(expect.arrayContaining([`eq:id=${A}`, "eq:list_id=L"]));
    expect((await res.json()).category).toEqual({ ...stored, name_ru: "Питомцы!" });
  });

  it("is 404 for a category of another list, before any AI call", async () => {
    use(renaming(null));
    expect((await PATCH(req("PATCH", { name: "x", locale: "en" }), catParams)).status).toBe(404);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.translateLimit).not.toHaveBeenCalled();
    expect(h.fake.calls.filter((c) => c.op === "update")).toEqual([]);
  });

  it("answers 500, with no AI call, when the category cannot be read", async () => {
    use((c) => c.op === "select" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
    expect((await PATCH(req("PATCH", { name: "x", locale: "en" }), catParams)).status).toBe(500);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.fake.calls.filter((c) => c.op === "update")).toEqual([]);
  });

  it("returns the category unchanged, with no AI call, when the name in that language is the same", async () => {
    use(renaming(stored));
    const res = await PATCH(req("PATCH", { name: "Питомцы", locale: "ru" }), catParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: stored });
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.translateLimit).not.toHaveBeenCalled();
    expect(h.fake.calls.filter((c) => c.op === "update")).toEqual([]);
  });

  it("renames when the typed name only matches another language's name", async () => {
    use(renaming(stored));
    expect((await PATCH(req("PATCH", { name: "Pets", locale: "ru" }), catParams)).status).toBe(200);
    expect(h.translate).toHaveBeenCalledWith("Pets");
    expect(h.fake.calls.find((c) => c.op === "update")!.values).toEqual({ name_en: "Pets", name_he: "חיות", name_ru: "Pets" });
  });

  it.each(budgetRefusals)("renames to the typed name in all three, with no AI call, when %s", async (_label, which, answer) => {
    h[which].mockImplementation(answer);
    use(renaming(stored));
    expect((await PATCH(req("PATCH", { name: "Animals", locale: "en" }), catParams)).status).toBe(200);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.fake.calls.find((c) => c.op === "update")!.values).toEqual({ name_en: "Animals", name_he: "Animals", name_ru: "Animals" });
  });

  it("answers 500, not 404, when the update fails", async () => {
    use(renaming(stored, { data: null, error: { message: "boom" } }));
    expect((await PATCH(req("PATCH", { name: "Animals", locale: "en" }), catParams)).status).toBe(500);
  });

  it("is 404 when the category is deleted before the update lands", async () => {
    use(renaming(stored, { data: null, error: null }));
    expect((await PATCH(req("PATCH", { name: "Animals", locale: "en" }), catParams)).status).toBe(404);
  });
});

describe("DELETE /categories/[categoryId]", () => {
  it("unlocks and empties its items, deletes it and sorts them again", async () => {
    use(() => ({ data: null, error: null }));
    const res = await DELETE(req("DELETE"), catParams);
    expect(res.status).toBe(200);
    const [release, del] = h.fake.calls;
    expect(release).toMatchObject({ table: "items", op: "update", values: { category_id: null, category_locked: false } });
    expect(release.filters).toEqual(expect.arrayContaining([`eq:category_id=${A}`, "eq:list_id=L"]));
    expect(del).toMatchObject({ table: "list_categories", op: "delete" });
    expect(del.filters).toEqual(expect.arrayContaining([`eq:id=${A}`, "eq:list_id=L"]));
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "pending");
  });

  // Deleting anyway would leave hand-placed items locked with no category, never re-sorted.
  it("keeps the category when its items cannot be released", async () => {
    use((c) => c.table === "items" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
    expect((await DELETE(req("DELETE"), catParams)).status).toBe(500);
    expect(h.fake.calls.filter((c) => c.op === "delete")).toEqual([]);
  });
});

describe("PUT /categories/order", () => {
  it("renumbers in the given order in one list-locked RPC", async () => {
    use((c) => c.op === "rpc" ? { data: true, error: null } : { data: null, error: null });
    const res = await PUT(req("PUT", { orderedIds: [B, A] }), listParams);
    expect(res.status).toBe(200);
    expect(h.fake.calls).toEqual([
      { table: "reorder_list_categories", op: "rpc", values: { p_list_id: "L", p_ordered_ids: [B, A] }, filters: [] },
    ]);
  });

  // The RPC writes nothing unless the order names every category of this list exactly once.
  it("rejects an order the RPC refuses", async () => {
    use((c) => c.op === "rpc" ? { data: false, error: null } : { data: null, error: null });
    expect((await PUT(req("PUT", { orderedIds: [A, C] }), listParams)).status).toBe(400);
  });

  it("answers 500 when the RPC fails", async () => {
    use((c) => c.op === "rpc" ? { data: null, error: { message: "boom" } } : { data: null, error: null });
    expect((await PUT(req("PUT", { orderedIds: [B, A] }), listParams)).status).toBe(500);
  });
});

describe("writes need edit permission", () => {
  const writes: [string, () => Promise<Response>][] = [
    ["POST", () => POST(req("POST", { name: "Pets", locale: "en" }), listParams)],
    ["PATCH", () => PATCH(req("PATCH", { name: "Pets", locale: "en" }), catParams)],
    ["DELETE", () => DELETE(req("DELETE"), catParams)],
    ["PUT", () => PUT(req("PUT", { orderedIds: [A, B] }), listParams)],
  ];
  it.each(writes)("%s asks for edit and touches nothing when refused", async (_m, call) => {
    h.perm = { allowed: false, role: "viewer" };
    use(() => ({ data: [{ id: A }, { id: B }], error: null }));
    expect((await call()).status).toBe(403);
    expect(h.permCalls[0]).toEqual(["u1", "L", "edit"]);
    expect(h.fake.calls).toEqual([]);
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.translateLimit).not.toHaveBeenCalled();
    expect(h.after).toEqual([]);
  });
});
