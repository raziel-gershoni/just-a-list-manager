/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListData against a faked network with a minimal slot-based React
// stand-in (state persists across calls, callbacks follow their deps). Nothing renders.
type Slot = { value?: unknown; deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
      return [slot.value, set];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn, deps };
      return fn;
    },
  };
});

import { useListData } from "@/src/hooks/useListData";
import { getSyncEngine, resetSyncEngines } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

const jwtRef: { current: string | null } = { current: "jwt" };
const render = () => { R.i = 0; return useListData("L", jwtRef); };

function stubFetch(categories: "fail" | 500 | unknown[], type = "grocery") {
  const f = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type }]);
    if (url.startsWith("/api/lists/L/items")) {
      return json({ items: [{ id: "a", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1, category_id: null }] });
    }
    if (url === "/api/lists/L/categories") {
      if (categories === "fail") throw new TypeError("Failed to fetch");
      if (categories === 500) return { ok: false, status: 500, json: async () => ({ error: "Failed to load categories" }) };
      return json({ categories });
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", f);
  return f;
}

// The list's offline queue: auto-unskip and auto-respawn go through its sync engine.
const storage = new Map<string, string>();

beforeEach(() => {
  resetSyncEngines();
  R.slots = [];
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useListData categories", () => {
  it("still opens the list when the categories request fails", async () => {
    stubFetch("fail");
    await render().fetchItems();
    const state = render();
    expect(state.error).toBe(false);
    expect(state.items.map((i) => i.id)).toEqual(["a"]);
    expect(state.categories).toEqual([]);
  });

  it("never asks for categories on a list that is not a grocery list", async () => {
    const f = stubFetch([], "regular");
    await render().fetchItems();
    await render().refreshItems();
    expect(f.mock.calls.map(([url]) => url)).not.toContain("/api/lists/L/categories");
    expect(f.mock.calls.length).toBeGreaterThan(0);
  });

  it("opens a list still stored with the retired reminders type as a regular list", async () => {
    // An old app version can create one during the deploy window; migration 029 retires the value.
    const f = stubFetch([], "reminders");
    await render().fetchItems();
    expect(render().listType).toBe("regular");
    expect(f.mock.calls.map(([url]) => url)).not.toContain("/api/lists/L/categories");
  });

  it("loads a grocery list's categories in walk order", async () => {
    stubFetch([
      { id: "dairy", list_id: "L", name_en: "Dairy", name_he: "", name_ru: "", position: 1, created_by: null },
      { id: "produce", list_id: "L", name_en: "Produce", name_he: "", name_ru: "", position: 0, created_by: null },
    ]);
    await render().fetchItems();
    expect(render().categories.map((c) => c.id)).toEqual(["produce", "dairy"]);
  });

  it("a failed categories request on refresh leaves items and categories as they were", async () => {
    stubFetch([{ id: "dairy", list_id: "L", name_en: "Dairy", name_he: "", name_ru: "", position: 0, created_by: null }]);
    await render().fetchItems();
    stubFetch("fail");
    await render().refreshItems();
    const state = render();
    expect(state.items.map((i) => i.id)).toEqual(["a"]);
    expect(state.categories.map((c) => c.id)).toEqual(["dairy"]);
  });

  it("a refresh picks up categories added since the list opened", async () => {
    stubFetch([dairy]);
    await render().fetchItems();
    stubFetch([dairy, produce]);
    await render().refreshItems();
    expect(render().categories.map((c) => c.id)).toEqual(["produce", "dairy"]);
  });
});

const dairy = { id: "dairy", list_id: "L", name_en: "Dairy", name_he: "", name_ru: "", position: 1, created_by: null };
const produce = { id: "produce", list_id: "L", name_en: "Produce", name_he: "", name_ru: "", position: 0, created_by: null };

describe("useListData loadCategories", () => {
  it("loads the categories in walk order, whatever type the list opened as", async () => {
    // A list switched to grocery in settings opened as regular, so nothing loaded them yet.
    const f = stubFetch([dairy, produce], "regular");
    await render().fetchItems();
    expect(render().categories).toEqual([]);

    await render().loadCategories();
    expect(render().categories.map((c) => c.id)).toEqual(["produce", "dairy"]);
    expect(f.mock.calls.filter(([url]) => url === "/api/lists/L/categories")).toHaveLength(1);
  });

  it("never throws: a request that fails to send is logged and changes nothing", async () => {
    stubFetch([dairy]);
    await render().fetchItems();
    stubFetch("fail");
    await expect(render().loadCategories()).resolves.toBeUndefined();
    expect(render().categories.map((c) => c.id)).toEqual(["dairy"]);
    expect(console.error).toHaveBeenCalledWith("[List] Categories fetch error:", expect.any(TypeError));
  });

  it("an error response changes nothing", async () => {
    stubFetch([dairy]);
    await render().fetchItems();
    stubFetch(500);
    await render().loadCategories();
    expect(render().categories.map((c) => c.id)).toEqual(["dairy"]);
  });

  it("does nothing before the user is signed in", async () => {
    const f = stubFetch([dairy]);
    jwtRef.current = null;
    try {
      await render().loadCategories();
    } finally {
      jwtRef.current = "jwt";
    }
    expect(f).not.toHaveBeenCalled();
    expect(render().categories).toEqual([]);
  });

  describe("retrySorting", () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id, text: id, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
      recurring: false, position: 1, category_id: null, category_locked: false, ...over,
    });

    function stubServer(state: { items: unknown[]; categories: unknown[] }) {
      const f = vi.fn(async (url: string) => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type: "grocery" }]);
        if (url.startsWith("/api/lists/L/items")) return json({ items: state.items });
        if (url === "/api/lists/L/categories") return json({ categories: state.categories });
        throw new Error(`unexpected ${url}`);
      });
      vi.stubGlobal("fetch", f);
      return f;
    }

    it("copies in a category the server has for an item still unsorted on screen, and touches nothing else", async () => {
      const server = { items: [row("a"), row("b"), row("c", { category_id: "produce" })], categories: [] as unknown[] };
      stubServer(server);
      await render().fetchItems();
      // On screen meanwhile: b was ticked off (not saved yet) and c moved by hand to bakery.
      render().setItems((prev) => prev.map((i) =>
        i.id === "b" ? { ...i, completed: true } : i.id === "c" ? { ...i, category_id: "bakery", category_locked: true } : i));

      server.items = [row("a", { category_id: "dairy" }), row("b", { category_id: "produce" }), row("c", { category_id: "produce" })];
      server.categories = [{ id: "dairy", list_id: "L", name_en: "Dairy", name_he: "", name_ru: "", position: 0, created_by: null }];
      await render().retrySorting();

      const items = Object.fromEntries(render().items.map((i) => [i.id, [i.category_id, i.completed]]));
      expect(items).toEqual({ a: ["dairy", false], b: ["produce", true], c: ["bakery", false] });
      expect(render().categories.map((c) => c.id)).toEqual(["dairy"]);
    });

    it("sends nothing without a token", async () => {
      const f = stubServer({ items: [row("a")], categories: [] });
      await render().fetchItems();
      f.mockClear();
      jwtRef.current = null as unknown as string;
      try {
        await render().retrySorting();
      } finally {
        jwtRef.current = "jwt";
      }
      expect(f).not.toHaveBeenCalled();
    });
  });
});

// Reminders were removed: opening or refreshing a list asks only for the list, its
// items and (on a grocery list) its categories, and no item carries reminder fields.
describe("useListData item loading", () => {
  it("never asks for reminders when a list opens or refreshes", async () => {
    for (const type of ["regular", "grocery"]) {
      R.slots = [];
      const f = stubFetch([], type);
      await render().fetchItems();
      await render().refreshItems();

      const urls = f.mock.calls.map(([url]) => url);
      expect(urls.filter((u) => u.includes("/reminders"))).toEqual([]);
      expect(render().error).toBe(false);
      expect(render().items.map((i) => i.id)).toEqual(["a"]);
    }
  });

  it("maps fetched and refreshed items without any reminder fields", async () => {
    stubFetch([], "regular");
    await render().fetchItems();
    const fetched = render().items[0] as unknown as Record<string, unknown>;
    await render().refreshItems();
    const refreshed = render().items[0] as unknown as Record<string, unknown>;

    for (const item of [fetched, refreshed]) {
      expect(item.id).toBe("a");
      expect(Object.keys(item).filter((k) => k.startsWith("my_remind"))).toEqual([]);
    }
  });
});

// A failed read is logged with its status. Only a failed list lookup changes the screen:
// without the list's details the header is blank and a grocery list opens as a regular one,
// so it shows the Retry screen instead.
describe("useListData failed reads", () => {
  type Reply = number | unknown;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: "Server error" }) });
  const groceries = { id: "L", name: "Groceries", type: "grocery" };
  const milk = { id: "a", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1, category_id: null };

  // Each route answers with a body (200) or a bare status number (an error response).
  function stubRoutes(routes: { lists?: Reply; archived?: Reply; items?: Reply; categories?: Reply; patch?: Reply }) {
    const reply = (r: Reply) => (typeof r === "number" ? fail(r) : ok(r));
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url === "/api/lists/L/items") return reply(routes.patch ?? { ok: true });
      if (url === "/api/lists") return reply(routes.lists ?? [groceries]);
      if (url === "/api/lists?archived=1") return reply(routes.archived ?? []);
      if (url.startsWith("/api/lists/L/items")) return reply(routes.items ?? { items: [milk] });
      if (url === "/api/lists/L/categories") return reply(routes.categories ?? { categories: [] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", f);
    return f;
  }
  const urls = (f: ReturnType<typeof stubRoutes>) => f.mock.calls.map(([url]) => url);

  it("a failed list lookup shows the Retry screen and never loads the items", async () => {
    const f = stubRoutes({ lists: 500 });
    await render().fetchItems();
    const state = render();
    expect(state.error).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.listName).toBe("");
    expect(urls(f)).toEqual(["/api/lists"]);
    expect(console.error).toHaveBeenCalledWith("[List] Fetch error:", expect.objectContaining({ message: "Load lists failed: 500" }));
  });

  it("a failed archived lookup shows the Retry screen too", async () => {
    const f = stubRoutes({ lists: [], archived: 503 });
    await render().fetchItems();
    expect(render().error).toBe(true);
    expect(urls(f)).toEqual(["/api/lists", "/api/lists?archived=1"]);
    expect(console.error).toHaveBeenCalledWith("[List] Fetch error:", expect.objectContaining({ message: "Load lists failed: 503" }));
  });

  it("a list missing from a good answer is still looked up among the archived lists", async () => {
    const f = stubRoutes({ lists: [{ id: "other", name: "Other" }], archived: [groceries] });
    await render().fetchItems();
    const state = render();
    expect(state.error).toBe(false);
    expect(state.listName).toBe("Groceries");
    expect(state.listType).toBe("grocery");
    expect(state.items.map((i) => i.id)).toEqual(["a"]);
    expect(urls(f)).toContain("/api/lists/L/categories");
  });

  it("a failed items load is logged with its status and shows the Retry screen", async () => {
    stubRoutes({ items: 500 });
    await render().fetchItems();
    expect(render().error).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[List] Load items failed:", { listId: "L", status: 500 });
  });

  it("a failed categories load is logged with its status and changes nothing", async () => {
    stubRoutes({ categories: { categories: [dairy] } });
    await render().fetchItems();
    stubRoutes({ categories: 500 });
    await render().loadCategories();
    expect(render().categories.map((c) => c.id)).toEqual(["dairy"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Categories load failed:", { listId: "L", status: 500 });
  });

  it("a failed background refresh is logged with its status and keeps the items", async () => {
    stubRoutes({});
    await render().fetchItems();
    stubRoutes({ items: 502 });
    await expect(render().refreshItems()).resolves.toBeUndefined();
    expect(render().items.map((i) => i.id)).toEqual(["a"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Background refresh failed:", { listId: "L", status: 502 });
  });

  it("a failed Sorting retry is logged with its status and asks for nothing else", async () => {
    stubRoutes({});
    await render().fetchItems();
    const f = stubRoutes({ items: 500 });
    await render().retrySorting();
    expect(urls(f)).toEqual(["/api/lists/L/items?limit=500"]);
    expect(console.warn).toHaveBeenCalledWith("[List] Sorting retry failed:", { listId: "L", status: 500 });
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const fiveHoursAgo = () => new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  // Auto-unskip and auto-respawn are changes like the user's own (R22): the list's sync
  // engine sends them in order with the user's changes, through executor-factory, and keeps
  // one the server refuses for a retry.
  const attachEngine = () =>
    getSyncEngine("L").attach({ getJwt: () => "jwt", executorFactory: createExecutorFactory() });
  const patches = (f: ReturnType<typeof stubRoutes>) =>
    f.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => JSON.parse(String(init!.body)));
  const queued = () => (JSON.parse(storage.get("mutation_queue:L") ?? "[]") as { type: string }[]).map((m) => m.type);

  it("an auto-unskip is sent by the list's sync engine, which keeps it when the server refuses it", async () => {
    attachEngine();
    const f = stubRoutes({ items: { items: [{ ...milk, skipped_at: fiveHoursAgo() }] }, patch: 500 });
    await render().fetchItems();
    await settle();
    expect(render().items[0].skipped_at).toBeNull();
    expect(patches(f)).toEqual([{ itemId: "a", skipped: false, at: expect.any(String) }]);
    expect(queued()).toEqual(["skip"]);
    expect(console.warn).toHaveBeenCalledWith(
      "[SyncEngine] Change failed, keeping it for a retry:",
      expect.objectContaining({ listId: "L", type: "skip" }),
      expect.objectContaining({ message: "Skip failed: 500" })
    );
  });

  it("an auto-respawn is sent by the list's sync engine, which keeps it when the server refuses it", async () => {
    attachEngine();
    const f = stubRoutes({ items: { items: [{ ...milk, recurring: true, completed: true, completed_at: fiveHoursAgo() }] }, patch: 500 });
    await render().fetchItems();
    await settle();
    expect(render().items[0].completed).toBe(false);
    expect(patches(f)).toEqual([{ itemId: "a", restoreRecurring: true }]);
    expect(queued()).toEqual(["restore-recurring"]);
    expect(console.warn).toHaveBeenCalledWith(
      "[SyncEngine] Change failed, keeping it for a retry:",
      expect.objectContaining({ listId: "L", type: "restore-recurring" }),
      expect.objectContaining({ message: "Restore recurring failed: 500" })
    );
  });

  it("an auto-unskip that lands leaves nothing queued", async () => {
    attachEngine();
    const f = stubRoutes({ items: { items: [{ ...milk, skipped_at: fiveHoursAgo() }] } });
    await render().fetchItems();
    await settle();
    expect(patches(f)).toEqual([{ itemId: "a", skipped: false, at: expect.any(String) }]);
    expect(queued()).toEqual([]);
  });

  // A viewer can't save either change (the server answers 403, which the engine drops and
  // reports as a sync error): the list still shows the item unskipped or respawned, and
  // nothing is queued or sent.
  it("a view-only collaborator's list queues and sends no auto-unskip or auto-respawn", async () => {
    attachEngine();
    const f = stubRoutes({
      lists: [{ ...groceries, role: "view" }],
      items: { items: [
        { ...milk, skipped_at: fiveHoursAgo() },
        { ...milk, id: "b", recurring: true, completed: true, completed_at: fiveHoursAgo() },
      ] },
      patch: 403,
    });
    await render().fetchItems();
    await settle();
    const items = render().items;
    expect(items.find((i) => i.id === "a")?.skipped_at).toBeNull();
    expect(items.find((i) => i.id === "b")?.completed).toBe(false);
    expect(patches(f)).toEqual([]);
    expect(queued()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an editor's list still sends both", async () => {
    attachEngine();
    const f = stubRoutes({
      lists: [{ ...groceries, role: "edit" }],
      items: { items: [
        { ...milk, skipped_at: fiveHoursAgo() },
        { ...milk, id: "b", recurring: true, completed: true, completed_at: fiveHoursAgo() },
      ] },
    });
    await render().fetchItems();
    await settle();
    expect(patches(f)).toEqual([
      { itemId: "a", skipped: false, at: expect.any(String) },
      { itemId: "b", restoreRecurring: true },
    ]);
  });

  it("logs nothing when every read succeeds", async () => {
    stubRoutes({ items: { items: [{ ...milk, skipped_at: fiveHoursAgo() }] } });
    await render().fetchItems();
    await render().refreshItems();
    await render().retrySorting();
    await settle();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
