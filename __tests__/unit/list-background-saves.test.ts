/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
// useListRealtime hands its change handler to useRealtimeList; keep it so a test can deliver events.
const RT = vi.hoisted(() => ({ onChange: null as ((change: unknown) => void) | null }));
vi.mock("@/src/hooks/useRealtimeList", () => ({
  useRealtimeList: (_c: unknown, _r: unknown, _l: unknown, onChange: (change: unknown) => void) => {
    RT.onChange = onChange;
    return { resubscribe: () => {} };
  },
}));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { useListRealtime } from "@/src/hooks/useListRealtime";
import ToastContainer from "@/components/list/ToastContainer";
import type { ItemData } from "@/src/types";

const DONE_A = "2026-10-20T09:00:00.000Z";
const DONE_B = "2026-10-21T18:30:00.000Z";

function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// How the fake server answers one request: a status, a network failure, or held until released.
type Reply = number | "neterr" | "hold";
type Undo = { message: string; undo: () => void; timeout: NodeJS.Timeout } | null;

// The list page around the real hook: items, the undo toast and the error toast live here,
// and fetch is a fake server. Keys: "PATCH <itemId>", "POST clear-completed", "POST unmark-completed".
function world(initial: ItemData[]) {
  let items = initial;
  let undoAction: Undo = null;
  let errorToast: string | null = null;
  const replies = new Map<string, Reply[]>();
  const held = new Map<string, (status: number) => void>();
  const sent: { key: string; body: unknown }[] = [];

  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = url.endsWith("/items") ? `${init.method} ${body.itemId}` : `${init.method} ${url.slice(url.lastIndexOf("/") + 1)}`;
    sent.push({ key, body });
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  }));

  const jwtRef = { current: "jwt" as string | null };
  const setItems = (u: ItemData[] | ((prev: ItemData[]) => ItemData[])) => {
    items = typeof u === "function" ? u(items) : u;
  };
  // A realtime event reaching the page, through the real useListRealtime handler.
  const realtime = (change: { eventType: string; new?: object; old?: object }) => {
    useListRealtime({
      supabaseClient: null,
      supabaseClientRef: { current: null },
      listId: "L",
      setItems,
      setListName: () => {},
      setCategories: () => {},
      isDraggingRef: { current: false },
      onListDeleted: () => {},
    });
    RT.onChange!({ table: "items", new: {}, old: {}, ...change });
  };
  // A fresh call reads the latest items, as a re-render would.
  const h = () =>
    useItemHandlers({
      listId: "L",
      jwtRef,
      userId: "u",
      items,
      setItems,
      addMutation: () => {},
      setUndoAction: (u) => { undoAction = typeof u === "function" ? u(undoAction) : u; },
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: (u) => { errorToast = typeof u === "function" ? u(errorToast) : u; },
      t: (key) => key,
    });

  return {
    h,
    realtime,
    when: (key: string, ...r: Reply[]) => replies.set(key, r),
    release: (key: string, status: number) => held.get(key)!(status),
    ids: () => items.map((i) => i.id).sort(),
    item: (id: string) => items.find((i) => i.id === id),
    undoAction: () => undoAction,
    errorToast: () => errorToast,
    sent,
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Clear completed fails", () => {
  const listItems = () => [
    item({ id: "a" }),
    item({ id: "b", completed: true, completed_at: DONE_A }),
    item({ id: "c", completed: true, completed_at: DONE_B }),
  ];

  it("a server error puts the cleared items back as they were, drops the undo and says so", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", 500);

    await w.h().handleClearCompleted();

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_A, deleted_at: null });
    expect(w.item("c")).toMatchObject({ completed: true, completed_at: DONE_B, deleted_at: null });
    expect(w.undoAction()).toBeNull();
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Clear completed failed:",
      { listId: "L" },
      expect.objectContaining({ message: "Clear completed failed: 500" })
    );
  });

  it("a clear that could not be sent does the same, without rejecting", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "neterr");

    await expect(w.h().handleClearCompleted()).resolves.toBeUndefined();

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith("[List] Clear completed failed:", { listId: "L" }, expect.any(TypeError));
  });

  it("a clear that fails after Undo was tapped shows each item once", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "hold");

    const clearing = w.h().handleClearCompleted();
    await settle();
    w.undoAction()!.undo();
    await settle();
    w.release("POST clear-completed", 500);
    await clearing;

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("a realtime INSERT for a cleared item that lands before the failure is merged back once", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "hold");

    const clearing = w.h().handleClearCompleted();
    await settle();
    w.realtime({ eventType: "INSERT", new: item({ id: "b", completed: true, completed_at: DONE_A }) });
    w.release("POST clear-completed", 500);
    await clearing;

    expect(w.ids()).toEqual(["a", "b", "c"]);
  });

  it("a realtime INSERT or UPDATE that arrives after the items were put back leaves each id once", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", 500);

    await w.h().handleClearCompleted();
    w.realtime({ eventType: "INSERT", new: item({ id: "b", completed: true, completed_at: DONE_A }) });
    w.realtime({ eventType: "UPDATE", new: { id: "c", deleted_at: null } });

    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.item("c")).toMatchObject({ completed: true, completed_at: DONE_B, deleted_at: null });
  });

  it("a clear the server accepted stays cleared, with its undo and no error", async () => {
    const w = world(listItems());

    await w.h().handleClearCompleted();

    expect(w.ids()).toEqual(["a"]);
    expect(w.undoAction()?.message).toBe("items.clearedCount");
    expect(w.errorToast()).toBeNull();
  });
});

describe("Unmark all done fails", () => {
  const listItems = () => [
    item({ id: "a", completed: true, completed_at: DONE_A }),
    item({ id: "b", completed: true, completed_at: DONE_B }),
    item({ id: "c" }),
  ];

  it("a server error re-checks the items with their original completion time, drops the undo and says so", async () => {
    const w = world(listItems());
    w.when("POST unmark-completed", 500);

    await w.h().handleUnmarkAllDone();

    expect(w.item("a")).toMatchObject({ completed: true, completed_at: DONE_A });
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_B });
    expect(w.item("c")).toMatchObject({ completed: false, completed_at: null });
    expect(w.undoAction()).toBeNull();
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Unmark all failed:",
      { listId: "L" },
      expect.objectContaining({ message: "Unmark all failed: 500" })
    );
  });

  it("an unmark that could not be sent does the same, without rejecting", async () => {
    const w = world(listItems());
    w.when("POST unmark-completed", "neterr");

    await expect(w.h().handleUnmarkAllDone()).resolves.toBeUndefined();

    expect(w.item("a")).toMatchObject({ completed: true, completed_at: DONE_A });
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("an unmark the server accepted stays unmarked, with no error", async () => {
    const w = world(listItems());

    await w.h().handleUnmarkAllDone();

    expect(w.item("a")).toMatchObject({ completed: false, completed_at: null });
    expect(w.errorToast()).toBeNull();
  });
});

describe("Undo restores on the list page", () => {
  it("Undo of a delete whose restore fails takes the item off the screen again and says so", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    w.when("PATCH b", 500);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200); // the exit animation
    expect(w.ids()).toEqual(["a"]);
    w.undoAction()!.undo();
    expect(w.ids()).toEqual(["a", "b"]);
    await settle();

    expect(w.sent).toContainEqual({ key: "PATCH b", body: { itemId: "b", deleted_at: null } });
    expect(w.ids()).toEqual(["a"]);
    expect(w.errorToast()).toBe("items.syncError");
    expect(errorSpy).toHaveBeenCalledWith(
      "[ItemRestore] Undo restore failed:",
      { listId: "L", itemId: "b" },
      expect.objectContaining({ message: "Restore failed: 500" })
    );
  });

  it("Undo of a delete whose restore lands keeps the item, with no error", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.errorToast()).toBeNull();
  });

  it("Undo of a duplicates removal takes off again only the duplicate whose restore failed", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);
    w.when("PATCH m3", 500);

    w.h().handleRemoveDuplicates("milk");
    expect(w.ids()).toEqual(["m1"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["m1", "m2"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("Undo of a clear takes off again only the items whose restore failed", async () => {
    const w = world([
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "c", completed: true, completed_at: DONE_B }),
    ]);
    w.when("PATCH c", "neterr");

    await w.h().handleClearCompleted();
    w.undoAction()!.undo();
    await settle();

    expect(w.ids()).toEqual(["b"]);
    expect(w.errorToast()).toBe("items.syncError");
  });

  it("Undo of unmark all unchecks again only the item whose restore failed", async () => {
    const w = world([
      item({ id: "a", completed: true, completed_at: DONE_A }),
      item({ id: "b", completed: true, completed_at: DONE_B }),
    ]);
    w.when("PATCH b", 500);

    await w.h().handleUnmarkAllDone();
    w.undoAction()!.undo();
    await settle();

    expect(w.sent).toContainEqual({ key: "PATCH b", body: { itemId: "b", completed: true } });
    expect(w.item("a")).toMatchObject({ completed: true });
    expect(w.item("b")).toMatchObject({ completed: false, completed_at: null });
    expect(w.errorToast()).toBe("items.syncError");
  });
});

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

function find(node: unknown, match: (el: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  return match(el) ? el : find(el.props.children, match);
}

const zOf = (className: unknown) => Number(/\bz-\[?(\d+)\]?/.exec(String(className))![1]);

describe("the list page's error toast", () => {
  it("draws above the page's sheets (the settings sheet sits at z-50), so a failure raised from one is seen", () => {
    const tree = ToastContainer({ reminderToast: null, duplicateWarning: null, errorToast: "errors.generic", undoAction: null });
    const toast = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "errors.generic") !== undefined);

    expect(toast).toBeDefined();
    expect(zOf(toast!.props.className)).toBeGreaterThan(50);
  });

  it("is message-only, so it never blocks the sheet buttons it draws over", () => {
    const tree = ToastContainer({ reminderToast: null, duplicateWarning: null, errorToast: "errors.generic", undoAction: null });
    const toast = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "errors.generic") !== undefined);

    expect(String(toast!.props.className)).toMatch(/\bpointer-events-none\b/);
  });
});
