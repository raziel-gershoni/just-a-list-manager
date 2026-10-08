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

const jwtRef = { current: "jwt" };
const render = () => { R.i = 0; return useListData("L", jwtRef); };

function stubFetch(categories: "fail" | unknown[], type = "grocery") {
  const f = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type }]);
    if (url.startsWith("/api/lists/L/items")) {
      return json({ items: [{ id: "a", text: "milk", completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1, category_id: null }] });
    }
    if (url.startsWith("/api/lists/L/reminders")) return json({ reminders: [] });
    if (url === "/api/lists/L/categories") {
      if (categories === "fail") throw new TypeError("Failed to fetch");
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
});
