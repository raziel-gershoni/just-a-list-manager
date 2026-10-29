/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListDragDrop in node (pattern: restore-skipped-flow.test.ts). The hook
// only uses useRef and useCallback, so a slot-based stand-in for React is enough: refs
// persist across renders and a callback is reused while its deps are unchanged, as in
// React. dnd-kit is not involved; handleDragEnd gets the event its sortable plugin sends,
// with the row's group and index at the drop.
type Slot = { current?: unknown; value?: unknown; deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    useRef: (v: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { current: v };
      return R.slots[i];
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
vi.mock("@/src/types/telegram", () => ({ getTelegramWebApp: () => null }));

import { useListDragDrop } from "@/src/hooks/useListDragDrop";
import { groupByCategory, isActiveItem } from "@/src/utils/list-helpers";
import type { ItemData, ListCategory } from "@/src/types";

type Hook = ReturnType<typeof useListDragDrop>;
type Queued = { id: string; type: string; payload: Record<string, unknown> };

const category = (id: string, position: number): ListCategory => ({
  id, list_id: "L", name_en: id, name_he: "", name_ru: "", position, created_by: null,
});

const item = (id: string, position: number, category_id: string | null): ItemData => ({
  id, text: id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
  ordered_at: null, category_id, category_locked: false, recurring: false, position,
  created_by: null, creator_name: null, edited_by: null, editor_name: null,
});

// A grocery list, top to bottom: milk still under "Sorting…", apples and bananas under
// Produce, cheese and yogurt under Dairy. `grouped: false` is a list shown flat.
function world({ grouped = true } = {}) {
  R.slots = [];
  let items = [
    item("milk", 5, null),
    item("apples", 4, "produce"),
    item("bananas", 3, "produce"),
    item("cheese", 2, "dairy"),
    item("yogurt", 1, "dairy"),
  ];
  let categories = [category("produce", 1), category("dairy", 2)];
  const setItems = vi.fn((u: ItemData[] | ((p: ItemData[]) => ItemData[])) => {
    items = typeof u === "function" ? u(items) : u;
  });
  const addMutation = vi.fn();
  const groups = () => {
    const active = items.filter(isActiveItem).sort((a, b) => b.position - a.position);
    return groupByCategory(active, categories, "en", "Sorting…");
  };

  // The list page re-renders with the latest items and categories.
  const render = (): Hook => {
    R.i = 0;
    return useListDragDrop({ items, setItems, addMutation, listId: "L", groups: grouped ? groups() : null });
  };

  return {
    render,
    setItems,
    setCategories: (next: ListCategory[]) => void (categories = next),
    item: (id: string) => items.find((i) => i.id === id)!,
    // What the grouped list shows now, as [group key, item ids] in display order.
    layout: () => groups().map((g) => [g.key, g.items.map((i) => i.id)]),
    queued: () => addMutation.mock.calls.map(([m]) => m as Queued),
  };
}

const start = (h: Hook) => (h.handleDragStart as unknown as () => void)();
const end = (h: Hook, id: string, sortable?: { group?: string; index: number }) =>
  (h.handleDragEnd as unknown as (e: unknown) => void)({
    canceled: false,
    operation: { source: { id, sortable }, target: { id: "cheese" } },
  });

beforeEach(() => {
  R.slots = [];
  R.i = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useListDragDrop grouped drops", () => {
  it("moves an item into another category: set-category first, then the new walk order", () => {
    const w = world();
    const h = w.render();
    start(h);
    end(h, "apples", { group: "dairy", index: 1 });

    expect(w.queued().map((m) => m.type)).toEqual(["set-category", "reorder"]);
    expect(w.queued()[0].payload).toEqual({ listId: "L", itemId: "apples", categoryId: "dairy" });
    expect(w.queued()[1].payload).toEqual({
      listId: "L",
      orderedIds: ["milk", "bananas", "cheese", "apples", "yogurt"],
    });
  });

  it("shows the moved item in its new category, placed by hand, before the server answers", () => {
    const w = world();
    const h = w.render();
    start(h);
    end(h, "apples", { group: "dairy", index: 1 });

    expect(w.item("apples")).toMatchObject({ category_id: "dairy", category_locked: true });
    expect(w.item("bananas")).toMatchObject({ category_id: "produce", category_locked: false });
    expect(w.layout()).toEqual([
      ["sorting", ["milk"]],
      ["produce", ["bananas"]],
      ["dairy", ["cheese", "apples", "yogurt"]],
    ]);
  });

  it("reorders inside a category without sending set-category or locking the item", () => {
    const w = world();
    const h = w.render();
    start(h);
    end(h, "bananas", { group: "produce", index: 0 });

    expect(w.queued().map((m) => m.type)).toEqual(["reorder"]);
    expect(w.queued()[0].payload.orderedIds).toEqual(["milk", "bananas", "apples", "cheese", "yogurt"]);
    expect(w.item("bananas")).toMatchObject({ category_id: "produce", category_locked: false });
    expect(w.layout()).toEqual([
      ["sorting", ["milk"]],
      ["produce", ["bananas", "apples"]],
      ["dairy", ["cheese", "yogurt"]],
    ]);
  });

  it.each([
    ["back where it was", { group: "produce", index: 0 }],
    ["into Sorting…", { group: "sorting", index: 0 }],
    ["with no sortable data", undefined],
  ])("a drop %s queues nothing, keeps updates that came in during the drag, and ends the drag", (_, sortable) => {
    const w = world();
    const h = w.render();
    start(h);
    // The AI sorts milk mid-drag; useListRealtime applies everything but position while dragging.
    w.setItems((prev) => prev.map((i) => (i.id === "milk" ? { ...i, category_id: "dairy" } : i)));
    end(h, "apples", sortable);

    expect(w.queued()).toEqual([]);
    expect(w.item("milk").category_id).toBe("dairy");
    expect(w.item("apples")).toMatchObject({ category_id: "produce", category_locked: false, position: 4 });
    expect(h.isDraggingRef.current).toBe(false);
  });

  it("uses the new walk order after the categories change while the items stay the same", () => {
    const w = world();
    w.render();
    // Dairy moved above Produce (e.g. over Realtime); no item changed.
    w.setCategories([category("produce", 2), category("dairy", 1)]);
    const h = w.render();
    start(h);
    end(h, "apples", { group: "dairy", index: 1 });

    expect(w.queued()[1].payload.orderedIds).toEqual(["milk", "cheese", "apples", "yogurt", "bananas"]);
  });

  it("queues the changes for the sync engine to send, and ends the drag at the drop", () => {
    // The requests themselves are executor-factory's (executor-factory.test.ts). Until the
    // reorder lands, the new positions are the engine's pending fields.
    const w = world();
    const h = w.render();
    start(h);
    expect(h.isDraggingRef.current).toBe(true);
    end(h, "apples", { group: "dairy", index: 1 });

    expect(w.queued().map((m) => Object.keys(m).sort())).toEqual([
      ["id", "payload", "type"],
      ["id", "payload", "type"],
    ]);
    expect(h.isDraggingRef.current).toBe(false);
  });
});

describe("useListDragDrop flat drops", () => {
  it("reorders by position alone when the list is not grouped", () => {
    const w = world({ grouped: false });
    const h = w.render();
    start(h);
    end(h, "apples", { index: 3 });

    expect(w.queued().map((m) => m.type)).toEqual(["reorder"]);
    expect(w.queued()[0].payload.orderedIds).toEqual(["milk", "bananas", "cheese", "apples", "yogurt"]);
    expect(w.item("apples")).toMatchObject({ category_id: "produce", category_locked: false, position: 2 });
  });
});
