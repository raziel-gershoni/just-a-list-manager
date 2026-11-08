import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
  after: [] as (() => unknown)[],
  categorize: vi.fn(async () => {}),
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: h.categorize }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => { h.after.push(fn); },
}));

import { PATCH } from "@/app/api/lists/route";

const LIST = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const patch = (body: unknown) =>
  new NextRequest("https://app.test/api/lists", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

// The owner check reads the list; the update answers with the saved row (or fails); the
// categories switch RPC answers with the saved row, nothing, or an error.
function use(opts: { updateFails?: boolean; switchFails?: boolean; switchMissing?: boolean; owner?: string } = {}) {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "lists" && c.op === "select") return { data: { owner_id: opts.owner ?? "u1" }, error: null };
    if (c.table === "lists" && c.op === "update") {
      return opts.updateFails ? { data: null, error: { message: "boom" } } : { data: { id: LIST, ...(c.values as object) }, error: null };
    }
    if (c.table === "set_list_categories_enabled") {
      if (opts.switchFails) return { data: null, error: { message: "boom" } };
      if (opts.switchMissing) return { data: [], error: null };
      return { data: [{ id: LIST, categories_enabled: (c.values as { p_enabled: boolean }).p_enabled }], error: null };
    }
    return { data: null, error: null };
  }) as typeof h.fake;
}
async function runAfter() { for (const fn of h.after) await fn(); }

beforeEach(() => {
  h.after = [];
  h.categorize.mockClear();
  vi.restoreAllMocks();
});

describe("PATCH /api/lists schedules categorization", () => {
  it("sorts a list right away when it becomes a grocery list", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, type: "grocery" }));
    expect(res.status).toBe(200);
    expect(h.after).toHaveLength(1);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.objectContaining({ supabase: expect.anything() }), LIST, "pending");
  });

  it.each([
    ["a switch to another type", { type: "regular" }],
    ["a rename", { name: "Groceries" }],
  ])("schedules nothing for %s", async (_label, change) => {
    use();
    const res = await PATCH(patch({ id: LIST, ...change }));
    expect(res.status).toBe(200);
    expect(h.after).toEqual([]);
  });

  it("schedules nothing when the switch to grocery fails to save", async () => {
    use({ updateFails: true });
    const res = await PATCH(patch({ id: LIST, type: "grocery" }));
    expect(res.status).toBe(500);
    expect(h.after).toEqual([]);
  });
});

describe("PATCH /api/lists categories switch", () => {
  const switchCalls = () => h.fake.calls.filter((c) => c.table === "set_list_categories_enabled");

  it("turning off runs the cleanup function, answers with the saved row and sorts nothing", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LIST, categories_enabled: false });
    expect(switchCalls().map((c) => c.values)).toEqual([{ p_list_id: LIST, p_enabled: false }]);
    expect(h.fake.calls.filter((c) => c.table === "lists" && c.op === "update")).toEqual([]);
    expect(h.after).toEqual([]);
  });

  it("turning on sets the switch and sorts the list from zero right away", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: true }));
    expect(res.status).toBe(200);
    expect(switchCalls().map((c) => c.values)).toEqual([{ p_list_id: LIST, p_enabled: true }]);
    expect(h.after).toHaveLength(1);
    await runAfter();
    expect(h.categorize).toHaveBeenCalledWith(expect.objectContaining({ supabase: expect.anything() }), LIST, "pending");
  });

  it("answers 500 and sorts nothing when the switch cannot be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    use({ switchFails: true });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: true }));
    expect(res.status).toBe(500);
    expect(h.after).toEqual([]);
  });

  it("answers 404 when the list is gone by the time the switch is saved", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    use({ switchMissing: true });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(404);
    expect(h.after).toEqual([]);
  });

  it("only the owner can change it", async () => {
    use({ owner: "someone-else" });
    const res = await PATCH(patch({ id: LIST, categoriesEnabled: false }));
    expect(res.status).toBe(403);
    expect(switchCalls()).toEqual([]);
  });

  it("is an update on its own, and must be a boolean", async () => {
    use();
    expect((await PATCH(patch({ id: LIST }))).status).toBe(400);
    expect((await PATCH(patch({ id: LIST, categoriesEnabled: "no" }))).status).toBe(400);
    expect(switchCalls()).toEqual([]);
  });

  it("a rename alongside it saves both", async () => {
    use();
    const res = await PATCH(patch({ id: LIST, name: "Flours", categoriesEnabled: false }));
    expect(res.status).toBe(200);
    expect(h.fake.calls.find((c) => c.table === "lists" && c.op === "update")!.values).toEqual({ name: "Flours" });
    expect(switchCalls()).toHaveLength(1);
  });
});
