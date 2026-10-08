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

const jwtRef: { current: string | null } = { current: "jwt" };
const render = () => { R.i = 0; return useListData("L", jwtRef); };

function stubFetch(categories: "fail" | 500 | unknown[], type = "grocery") {
  const f = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type }]);
    if (url.startsWith("/api/lists/L/items")) {
      return json({ items: [{ id: "a", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1, category_id: null }] });
    }
    if (url.startsWith("/api/lists/L/reminders")) return json({ reminders: [] });
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

beforeEach(() => {
  R.slots = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
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
        if (url.startsWith("/api/lists/L/reminders")) return json({ reminders: [] });
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
