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
  // What a bulk route answers: by default it changed every id it was sent, as the real
  // routes do when nothing else touched those rows.
  const changed = new Map<string, string[]>();
  // The count the last Undo toast showed.
  let undoCount: unknown;
  // What the handlers queued, in order: "<type> <itemId | recycleId | text>".
  const queued: string[] = [];

  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = url.endsWith("/items") ? `${init.method} ${body.itemId}` : `${init.method} ${url.slice(url.lastIndexOf("/") + 1)}`;
    sent.push({ key, body });
    const reply = replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") throw new TypeError("Failed to fetch");
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    const answer =
      key === "POST clear-completed" ? { clearedIds: changed.get(key) ?? body.itemIds }
      : key === "POST unmark-completed" ? { unmarkedIds: changed.get(key) ?? body.itemIds }
      : {};
    return { ok: status >= 200 && status < 300, status, json: async () => answer };
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
      setListType: () => {},
      setListIcon: () => {},
      setListColor: () => {},
      listType: "regular",
      loadCategories: async () => {},
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
      addMutation: (m) => {
        const p = m.payload;
        queued.push(`${m.type} ${p.itemId ?? p.recycleId ?? p.text}`);
      },
      setUndoAction: (u) => { undoAction = typeof u === "function" ? u(undoAction) : u; },
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: (u) => { errorToast = typeof u === "function" ? u(errorToast) : u; },
      t: (key, values) => {
        if (key === "items.clearedCount" || key === "items.unmarkedCount") undoCount = values?.count;
        return key;
      },
    });

  return {
    h,
    realtime,
    when: (key: string, ...r: Reply[]) => replies.set(key, r),
    // The ids a bulk route says it changed (its clearedIds / unmarkedIds).
    changes: (key: string, ids: string[]) => changed.set(key, ids),
    undoCount: () => undoCount,
    release: (key: string, status: number) => held.get(key)!(status),
    ids: () => items.map((i) => i.id).sort(),
    item: (id: string) => items.find((i) => i.id === id),
    undoAction: () => undoAction,
    errorToast: () => errorToast,
    sent,
    queued,
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

  it("an Undo tapped while the clear is in flight does not revert when the clear then fails and its restore fails too", async () => {
    const w = world(listItems());
    w.when("POST clear-completed", "hold");
    w.when("PATCH b", "hold");
    w.when("PATCH c", "hold");

    const clearing = w.h().handleClearCompleted();
    await settle();
    w.undoAction()!.undo();
    await settle();
    w.release("POST clear-completed", 500);
    await clearing;
    w.release("PATCH b", 503);
    w.release("PATCH c", 503);
    await settle();

    // The server never cleared anything, so the failed restores must not take the items off.
    expect(w.ids()).toEqual(["a", "b", "c"]);
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_A, deleted_at: null });
    expect(w.item("c")).toMatchObject({ completed: true, completed_at: DONE_B, deleted_at: null });
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

  it("an Undo tapped while the unmark is in flight does not revert when the unmark then fails and its restore fails too", async () => {
    const w = world(listItems());
    w.when("POST unmark-completed", "hold");
    w.when("PATCH a", "hold");
    w.when("PATCH b", "hold");

    const unmarking = w.h().handleUnmarkAllDone();
    await settle();
    w.undoAction()!.undo();
    await settle();
    w.release("POST unmark-completed", 500);
    await unmarking;
    w.release("PATCH a", 503);
    w.release("PATCH b", 503);
    await settle();

    // The server never unmarked anything, so the failed restores must not uncheck the items.
    expect(w.item("a")).toMatchObject({ completed: true, completed_at: DONE_A });
    expect(w.item("b")).toMatchObject({ completed: true, completed_at: DONE_B });
    expect(w.item("c")).toMatchObject({ completed: false, completed_at: null });
  });

  it("an unmark the server accepted stays unmarked, with no error", async () => {
    const w = world(listItems());

    await w.h().handleUnmarkAllDone();

    expect(w.item("a")).toMatchObject({ completed: false, completed_at: null });
    expect(w.errorToast()).toBeNull();
  });
});

describe("Undo restores on the list page", () => {
  // A failed restore is the queue's job now: a dropped one shows items.syncError and
  // refreshes the list (onMutationError), a kept one is retried. See undo-delete-queued.test.ts.
  it("Undo of a delete queues a restore behind the delete instead of sending its own PATCH", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    await vi.advanceTimersByTimeAsync(200); // the exit animation
    expect(w.ids()).toEqual(["a"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.queued).toEqual(["delete b", "restore b"]);
    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.errorToast()).toBeNull();
  });

  it("an Undo inside the exit animation keeps the item on screen, once", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);

    await w.h().handleDelete("b");
    w.undoAction()!.undo(); // before the 200 ms removal fires
    await vi.advanceTimersByTimeAsync(500);

    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.item("b")?._exiting).toBeFalsy();
    expect(w.queued).toEqual(["delete b", "restore b"]);
  });

  it("Undo of a duplicates removal queues one restore per removed duplicate", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);

    w.h().handleRemoveDuplicates("milk");
    expect(w.ids()).toEqual(["m1"]);
    w.undoAction()!.undo();
    await settle();

    expect(w.queued).toEqual(["delete m2", "delete m3", "restore m2", "restore m3"]);
    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual(["m1", "m2", "m3"]);
  });

  it("Undo of a clear restores on the server only what the clear sent; an unsaved item just comes back", async () => {
    const w = world([
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleClearCompleted();
    w.undoAction()!.undo();
    await settle();

    expect(w.sent.map((s) => s.key)).toEqual(["POST clear-completed", "PATCH b"]);
    expect(w.ids()).toEqual(["b", "temp-x"]);
    expect(w.errorToast()).toBeNull();
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

describe("Clear completed and Unmark all act only on what the screen showed", () => {
  it("Clear completed sends the ids it cleared: no parked recurring item, no unsaved item", async () => {
    const w = world([
      item({ id: "a" }),
      item({ id: "b", completed: true, completed_at: DONE_A }),
      item({ id: "c", completed: true, completed_at: DONE_B }),
      item({ id: "r", completed: true, completed_at: DONE_A, recurring: true }),
      item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleClearCompleted();

    expect(w.sent).toEqual([{ key: "POST clear-completed", body: { itemIds: ["b", "c"] } }]);
    expect(w.ids()).toEqual(["a", "r"]);
  });

  it("Clear completed with only unsaved items sends nothing", async () => {
    const w = world([item({ id: "temp-x", text: "x", completed: true, completed_at: DONE_A, _pending: true })]);

    await w.h().handleClearCompleted();

    expect(w.sent).toEqual([]);
    expect(w.ids()).toEqual([]);
    expect(w.undoAction()?.message).toBe("items.clearedCount");
  });

  it("Unmark all sends the ids it unmarked, without unsaved ones", async () => {
    const w = world([
      item({ id: "a", completed: true, completed_at: DONE_A }),
      item({ id: "b", completed: true, completed_at: DONE_B }),
      item({ id: "temp-y", text: "y", completed: true, completed_at: DONE_B, _pending: true }),
      item({ id: "c" }),
    ]);

    await w.h().handleUnmarkAllDone();

    expect(w.sent).toEqual([{ key: "POST unmark-completed", body: { itemIds: ["a", "b"] } }]);
    expect(w.item("temp-y")).toMatchObject({ completed: false, completed_at: null });
  });

  it("Unmark all leaves a parked recurring item a regular list never shows, and counts only the shown one", async () => {
    const w = world([
      item({ id: "shown", completed: true, completed_at: DONE_A }),
      item({ id: "parked", completed: true, completed_at: DONE_B, recurring: true }),
    ]);

    await w.h().handleUnmarkAllDone();

    expect(w.sent).toEqual([{ key: "POST unmark-completed", body: { itemIds: ["shown"] } }]);
    expect(w.undoCount()).toBe(1);
    expect(w.item("parked")).toMatchObject({ completed: true, completed_at: DONE_B });
  });

  it("Unmark all with only unsaved items sends nothing", async () => {
    const w = world([item({ id: "temp-y", text: "y", completed: true, completed_at: DONE_A, _pending: true })]);

    await w.h().handleUnmarkAllDone();

    expect(w.sent).toEqual([]);
    expect(w.item("temp-y")).toMatchObject({ completed: false });
  });
});

describe("Remove duplicates keeps the active copy", () => {
  it("after a drag, when the done copy has the higher position", () => {
    const w = world([
      item({ id: "active-milk", text: "milk", position: 3 }),
      item({ id: "done-milk", text: "milk", position: 1730000000000, completed: true, completed_at: DONE_A }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued).toEqual(["delete done-milk"]);
    expect(w.ids()).toEqual(["active-milk"]);
  });

  it("when the done copy is the newer one", () => {
    const w = world([
      item({ id: "active-milk", text: "milk", position: 1729000000000 }),
      item({ id: "done-milk", text: "Milk", position: 1730000000000, completed: true, completed_at: DONE_A }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued).toEqual(["delete done-milk"]);
  });

  it("over a skipped copy, and keeps the higher position among active copies", () => {
    const w = world([
      item({ id: "skipped-milk", text: "milk", position: 9, skipped_at: DONE_A }),
      item({ id: "low-milk", text: "milk", position: 2 }),
      item({ id: "high-milk", text: "milk", position: 5 }),
    ]);

    w.h().handleRemoveDuplicates("milk");

    expect(w.queued.sort()).toEqual(["delete low-milk", "delete skipped-milk"]);
    expect(w.ids()).toEqual(["high-milk"]);
  });
});

describe("a typed add recycles a completed item with the same text", () => {
  it("Enter on a done item's text brings that item back instead of adding a second row", async () => {
    const w = world([item({ id: "done-milk", text: "milk", completed: true, completed_at: DONE_A })]);

    await w.h().handleAddItem("Milk");

    expect(w.queued).toEqual(["recycle done-milk"]);
    expect(w.ids()).toEqual(["done-milk"]);
    expect(w.item("done-milk")).toMatchObject({ completed: false, completed_at: null, created_by: "u" });
  });

  it("each comma segment recycles its match once; the rest are added", async () => {
    const w = world([item({ id: "done-milk", text: "milk", completed: true, completed_at: DONE_A })]);

    await w.h().handleAddItem("bread, milk, milk");

    expect(w.queued).toEqual(["create bread", "recycle done-milk", "create milk"]);
  });

  it("takes the most recently completed exact match; a substring match never recycles", async () => {
    const w = world([
      item({ id: "chocolate", text: "milk chocolate", completed: true, completed_at: "2026-10-22T08:00:00.000Z" }),
      item({ id: "old-milk", text: "milk", completed: true, completed_at: DONE_A }),
      item({ id: "new-milk", text: "milk", completed: true, completed_at: DONE_B }),
    ]);

    await w.h().handleAddItem("milk");
    await w.h().handleAddItem("chocolate");

    expect(w.queued).toEqual(["recycle new-milk", "create chocolate"]);
  });

  it("never recycles an active, deleted or unsaved row", async () => {
    const w = world([
      item({ id: "active-milk", text: "milk" }),
      item({ id: "gone-milk", text: "milk", completed: true, completed_at: DONE_A, deleted_at: DONE_B }),
      item({ id: "temp-milk", text: "milk", completed: true, completed_at: DONE_B, _pending: true }),
    ]);

    await w.h().handleAddItem("milk");

    expect(w.queued).toEqual(["create milk"]);
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

  it("still shows while an Undo toast is showing, above it", () => {
    const undoAction = { message: "items.clearedCount", undo: () => {}, timeout: 0 as unknown as NodeJS.Timeout };
    const tree = ToastContainer({ reminderToast: null, duplicateWarning: null, errorToast: "errors.generic", undoAction });
    const errorBox = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "errors.generic") !== undefined);
    const undoBox = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "items.clearedCount") !== undefined);

    expect(errorBox).toBeDefined();
    expect(undoBox).toBeDefined();
    expect(String(errorBox!.props.className)).toContain("bottom-24");
    expect(String(undoBox!.props.className)).toContain("bottom-8");
    expect(String(errorBox!.props.className)).toMatch(/\bpointer-events-none\b/);
    expect(zOf(errorBox!.props.className)).toBeGreaterThan(50);
  });

  it("is message-only, so it never blocks the sheet buttons it draws over", () => {
    const tree = ToastContainer({ reminderToast: null, duplicateWarning: null, errorToast: "errors.generic", undoAction: null });
    const toast = find(tree, (el) => el.type === "div" && find(el.props.children, (c) => c.props.children === "errors.generic") !== undefined);

    expect(String(toast!.props.className)).toMatch(/\bpointer-events-none\b/);
  });
});
