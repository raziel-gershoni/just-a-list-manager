/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach } from "vitest";

// useListRealtime only needs useCallback here; React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
// Keep the change handler the hook hands to useRealtimeList, so a test can deliver events.
const RT = vi.hoisted(() => ({ onChange: null as ((change: unknown) => void) | null }));
vi.mock("@/src/hooks/useRealtimeList", () => ({
  useRealtimeList: (_c: unknown, _r: unknown, _l: unknown, onChange: (change: unknown) => void) => {
    RT.onChange = onChange;
    return { resubscribe: () => {} };
  },
}));

import { useListRealtime } from "@/src/hooks/useListRealtime";

// The open list page's header state, fed by the real hook.
function page(listType: "regular" | "grocery") {
  const state = { name: "Groceries", type: listType as string, icon: "cart" as string | null, color: "blue" as string | null };
  const apply = <T,>(key: keyof typeof state) => (u: T | ((p: T) => T)) => {
    const prev = state[key] as T;
    (state as Record<string, unknown>)[key] = typeof u === "function" ? (u as (p: T) => T)(prev) : u;
  };
  const loadCategories = vi.fn(async () => {});
  const onListDeleted = vi.fn();
  const params = {
    supabaseClient: null,
    supabaseClientRef: { current: null },
    listId: "L",
    setItems: () => {},
    setListName: apply<string>("name"),
    setListType: apply<string>("type"),
    setListIcon: apply<string | null>("icon"),
    setListColor: apply<string | null>("color"),
    listType,
    loadCategories,
    setCategories: () => {},
    isDraggingRef: { current: false },
    onListDeleted,
  } as unknown as Parameters<typeof useListRealtime>[0];
  useListRealtime(params);
  const listUpdate = (row: Record<string, unknown>) =>
    RT.onChange!({ table: "lists", eventType: "UPDATE", new: { id: "L", deleted_at: null, ...row }, old: { id: "L" } });
  return { state, loadCategories, onListDeleted, listUpdate };
}

beforeEach(() => {
  RT.onChange = null;
});

describe("an open list follows the owner's list settings live", () => {
  it("a switch to grocery changes the type and loads the categories", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "grocery", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("grocery");
    expect(p.loadCategories).toHaveBeenCalledTimes(1);
  });

  it("a switch back to regular changes the type and loads nothing", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Groceries", type: "regular", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("regular");
    expect(p.loadCategories).not.toHaveBeenCalled();
  });

  it("an update of a grocery list that stays grocery does not reload the categories", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Food", type: "grocery", icon: "cart", color: "blue" });

    expect(p.state.name).toBe("Food");
    expect(p.loadCategories).not.toHaveBeenCalled();
  });

  it("a type the app no longer has opens as a regular list", () => {
    const p = page("grocery");

    p.listUpdate({ name: "Groceries", type: "reminders", icon: "cart", color: "blue" });

    expect(p.state.type).toBe("regular");
  });

  it("a new icon and color show at once, and a cleared one clears", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "regular", icon: "home", color: "green" });
    expect(p.state).toMatchObject({ icon: "home", color: "green" });

    p.listUpdate({ name: "Groceries", type: "regular", icon: null, color: null });
    expect(p.state).toMatchObject({ icon: null, color: null });
  });

  it("an update without those columns leaves the header as it is", () => {
    const p = page("regular");

    p.listUpdate({ name: "Renamed" });

    expect(p.state).toEqual({ name: "Renamed", type: "regular", icon: "cart", color: "blue" });
  });

  it("a deleted list still goes home and changes nothing else", () => {
    const p = page("regular");

    p.listUpdate({ name: "Groceries", type: "grocery", icon: "home", deleted_at: "2026-10-29T10:00:00.000Z" });

    expect(p.onListDeleted).toHaveBeenCalledTimes(1);
    expect(p.state).toEqual({ name: "Groceries", type: "regular", icon: "cart", color: "blue" });
    expect(p.loadCategories).not.toHaveBeenCalled();
  });
});
