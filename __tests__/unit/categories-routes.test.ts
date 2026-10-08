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
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
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
});

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
  it("translates, keeps the typed name in the user's language, appends last and re-scans", async () => {
    use((c) => {
      if (c.op === "select") return { data: [{ id: B, position: 0 }, { id: A, position: 3 }], error: null };
      if (c.op === "insert") return { data: { id: "new", ...(c.values as object) }, error: null };
      return { data: null, error: null };
    });
    const res = await POST(req("POST", { name: "  חיות מחמד ", locale: "he" }), listParams);
    expect(res.status).toBe(201);
    expect(h.translate).toHaveBeenCalledWith("חיות מחמד");
    expect(h.fake.calls.find((c) => c.op === "select")!.filters).toContain("eq:list_id=L");
    const insert = h.fake.calls.find((c) => c.op === "insert")!;
    expect(insert.values).toEqual({ list_id: "L", name_en: "Pets", name_he: "חיות מחמד", name_ru: "Питомцы", position: 4, created_by: "u1" });
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.anything(), "L", "rescan");
  });

  it("uses the typed name everywhere when translation fails", async () => {
    h.translate.mockResolvedValueOnce(null);
    use((c) => c.op === "insert" ? { data: { id: "new" }, error: null } : { data: [], error: null });
    await POST(req("POST", { name: "Pets", locale: "en" }), listParams);
    expect(h.fake.calls.find((c) => c.op === "insert")!.values).toMatchObject({ name_en: "Pets", name_he: "Pets", name_ru: "Pets", position: 0 });
  });

  it("refuses a 21st category", async () => {
    use(() => ({ data: Array.from({ length: 20 }, (_, k) => ({ id: `k${k}`, position: k })), error: null }));
    const res = await POST(req("POST", { name: "One more", locale: "en" }), listParams);
    expect(res.status).toBe(400);
    expect(h.fake.calls.filter((c) => c.op === "insert")).toEqual([]);
  });

  // A failed read must not look like an empty list: that would skip the cap and reuse position 0.
  it("adds nothing when the existing categories cannot be read", async () => {
    use((c) => c.op === "select" ? { data: null, error: { message: "boom" } } : { data: { id: "new" }, error: null });
    expect((await POST(req("POST", { name: "Pets", locale: "en" }), listParams)).status).toBe(500);
    expect(h.fake.calls.filter((c) => c.op === "insert")).toEqual([]);
    expect(h.after).toEqual([]);
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
  it("renames all three names, keeping the typed one in the user's language", async () => {
    use((c) => c.op === "update" ? { data: { id: A }, error: null } : { data: null, error: null });
    const res = await PATCH(req("PATCH", { name: "Питомцы!", locale: "ru" }), catParams);
    expect(res.status).toBe(200);
    const update = h.fake.calls.find((c) => c.op === "update")!;
    expect(update.values).toEqual({ name_en: "Pets", name_he: "חיות", name_ru: "Питомцы!" });
    expect(update.filters).toEqual(expect.arrayContaining([`eq:id=${A}`, "eq:list_id=L"]));
  });

  it("is 404 for a category of another list", async () => {
    use(() => ({ data: null, error: null }));
    expect((await PATCH(req("PATCH", { name: "x", locale: "en" }), catParams)).status).toBe(404);
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
  it("renumbers in the given order", async () => {
    use((c) => c.op === "select" ? { data: [{ id: A }, { id: B }], error: null } : { data: null, error: null });
    const res = await PUT(req("PUT", { orderedIds: [B, A] }), listParams);
    expect(res.status).toBe(200);
    expect(h.fake.calls.find((c) => c.op === "select")!.filters).toContain("eq:list_id=L");
    const updates = h.fake.calls.filter((c) => c.op === "update");
    expect(updates.map((c) => [c.values, c.filters.filter((f) => f.startsWith("eq:id"))])).toEqual([[{ position: 0 }, [`eq:id=${B}`]], [{ position: 1 }, [`eq:id=${A}`]]]);
    for (const u of updates) expect(u.filters).toContain("eq:list_id=L");
  });

  it.each([
    ["misses one", [A]],
    ["repeats one", [A, B, A]],
    ["names another list's", [A, C]],
  ])("rejects an order that %s", async (_label, orderedIds) => {
    use((c) => c.op === "select" ? { data: [{ id: A }, { id: B }], error: null } : { data: null, error: null });
    expect((await PUT(req("PUT", { orderedIds }), listParams)).status).toBe(400);
    expect(h.fake.calls.filter((c) => c.op === "update")).toEqual([]);
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
    expect(h.after).toEqual([]);
  });
});
