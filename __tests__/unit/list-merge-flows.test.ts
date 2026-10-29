/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hooks run as plain functions */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useListData, useListRealtime and useItemHandlers on the real sync engine and
// executor factory, against a fake server. A minimal slot-based stand-in for React runs the
// hooks in node: state persists across renders, callbacks and memos follow their deps, and
// effects run synchronously during render. Nothing renders to a DOM.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
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
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && same(s.deps, deps)) return s.value;
      R.slots[i] = { value: fn(), deps };
      return R.slots[i].value;
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      if (s && typeof s.cleanup === "function") s.cleanup();
      R.slots[i] = { deps, cleanup: fn() };
    },
  };
});
// useListRealtime hands its change handler to useRealtimeList; keep it so a test can deliver events.
const RT = vi.hoisted(() => ({ onChange: null as ((change: unknown) => void) | null }));
vi.mock("@/src/hooks/useRealtimeList", () => ({
  useRealtimeList: (_c: unknown, _r: unknown, _l: unknown, onChange: (change: unknown) => void) => {
    RT.onChange = onChange;
    return { resubscribe: async () => {} };
  },
}));

import { useListData } from "@/src/hooks/useListData";
import { useListRealtime } from "@/src/hooks/useListRealtime";
import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { getSyncEngine } from "@/src/sync/engine";
import { applyCreateResult } from "@/src/sync/merge";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { ItemData } from "@/src/types";

const DONE = "2026-10-22T09:00:00.000Z";

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// Each test gets its own list id: the engine registry is module-level.
let listSeq = 0;

// One open list page: the hooks the page runs, the engine it attaches to, and a fake server.
// A request is answered with a status or held until the test releases it. Keys:
// "GET items", "PATCH <itemId>", "DELETE <itemId>", "POST <n>" (the n-th create, from 1).
function page(serverItems: ItemData[]) {
  const listId = `L${++listSeq}`;
  const server = { items: serverItems };
  const holds = new Set<string>();
  const waiting = new Map<string, (reply: { status: number; body?: unknown }) => void>();
  const replies = new Map<string, number>();
  const sent: { key: string; body: Record<string, unknown> | undefined }[] = [];
  let posts = 0;

  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (method === "GET" && url === "/api/lists") return { ok: true, status: 200, json: async () => [{ id: listId, name: "Groceries", type: "regular" }] };
    const key =
      method === "GET" ? "GET items"
      : method === "POST" ? `POST ${++posts}`
      : method === "DELETE" ? `DELETE ${new URL(url, "https://app.test").searchParams.get("itemId")}`
      : `${method} ${body.itemId}`;
    sent.push({ key, body });
    const answer = (): { status: number; body?: unknown } =>
      method === "GET" ? { status: replies.get(key) ?? 200, body: { items: server.items } } : { status: replies.get(key) ?? 200, body: {} };
    const reply = holds.has(key)
      ? await new Promise<{ status: number; body?: unknown }>((resolve) => waiting.set(key, resolve))
      : answer();
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  }));

  const jwtRef = { current: "jwt" as string | null };
  const engine = getSyncEngine(listId);
  let data!: ReturnType<typeof useListData>;
  const render = () => {
    R.i = 0;
    data = useListData(listId, jwtRef);
    useListRealtime({
      supabaseClient: null,
      supabaseClientRef: { current: null },
      listId,
      setItems: data.setItems,
      setListName: data.setListName,
      setCategories: data.setCategories,
      isDraggingRef: { current: false },
      onListDeleted: () => {},
    });
    return useItemHandlers({
      listId,
      jwtRef,
      userId: "u",
      items: data.items,
      setItems: data.setItems,
      addMutation: (m: { id: string; type: string; payload: Record<string, unknown> }) =>
        engine.add({ id: m.id, type: m.type, payload: m.payload }),
      setUndoAction: () => {},
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: () => {},
      t: (key: string) => key,
    });
  };
  // The page's create success handler: the saved row replaces the temp row.
  const detach = engine.attach({
    getJwt: () => jwtRef.current,
    executorFactory: createExecutorFactory(),
    onSuccess: (m, result) => {
      if (m.type === "create" && typeof m.payload.tempId === "string") {
        const tempId = m.payload.tempId;
        data.setItems((prev) => applyCreateResult(prev, tempId, result as ItemData, (id) => engine.pendingFields(id)));
      }
    },
  });

  return {
    listId,
    server,
    render,
    detach,
    hold: (key: string) => holds.add(key),
    reply: (key: string, status: number) => replies.set(key, status),
    release: (key: string, status: number, body: unknown = {}) => {
      holds.delete(key);
      waiting.get(key)!({ status, body });
    },
    realtime: (change: { eventType: string; new?: object; old?: object }) => {
      render();
      RT.onChange!({ table: "items", new: {}, old: {}, ...change });
    },
    load: async () => {
      render();
      await data.fetchItems();
    },
    refresh: async () => {
      render();
      await data.refreshItems();
    },
    items: () => { render(); return data.items; },
    item: (id: string) => { render(); return data.items.find((i) => i.id === id); },
    sent,
  };
}

let current: ReturnType<typeof page> | null = null;
// Opens the list page on a server holding these items.
const open = async (serverItems: ItemData[]) => {
  current = page(serverItems);
  await current.load();
  return current;
};

beforeEach(() => {
  R.slots = [];
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  current?.detach();
  current = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a background refresh merges into the screen", () => {
  it("a tick still being saved stays ticked, and a collaborator's rename of the item still shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;

    p.server.items = [row({ id: "a", text: "oat milk" })];
    await p.refresh();

    expect(p.item("a")).toMatchObject({ text: "oat milk", completed: true });
  });

  it("once the tick is saved, the server's values show again", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    p.release("PATCH a", 200);
    await settle();

    // A collaborator unticked it after the tick was saved.
    p.server.items = [row({ id: "a", text: "milk", completed: false })];
    await p.refresh();

    expect(p.item("a")?.completed).toBe(false);
  });

  it("a tick kept for retry after a server error stays ticked through a refresh", async () => {
    const p = await open([row({ id: "a" })]);
    p.reply("PATCH a", 500);
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await settle();

    await p.refresh();

    expect(p.item("a")?.completed).toBe(true);
  });

  it("a new item still being saved stays on screen next to a saved item with the same text", async () => {
    const p = await open([row({ id: "old", text: "milk" })]);
    p.hold("POST 1");
    await p.render().handleAddItem("milk");

    await p.refresh();

    const milks = p.items().filter((i) => i.text === "milk").map((i) => i.id);
    expect(milks).toHaveLength(2);
    expect(milks).toEqual(expect.arrayContaining(["old", expect.stringMatching(/^temp-/)]));
  });

  it("an item deleted on screen with its delete still on its way is not brought back", async () => {
    const p = await open([row({ id: "a" }), row({ id: "b" })]);
    p.hold("DELETE a");
    await p.render().handleDelete("a");
    await vi.advanceTimersByTimeAsync(200);

    await p.refresh();

    expect(p.items().map((i) => i.id)).toEqual(["b"]);
  });

  it("an item whose create finished while the GET was out stays, although the snapshot predates it", async () => {
    const p = await open([]);
    p.hold("POST 1");
    await p.render().handleAddItem("eggs");
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    // The create is answered and its echo arrives, then the older snapshot comes back.
    p.release("POST 1", 201, { items: [row({ id: "r1", text: "eggs" })] });
    await settle();
    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "eggs" }) });
    p.release("GET items", 200, { items: [] });
    await refreshing;

    expect(p.items().map((i) => i.id)).toEqual(["r1"]);
  });
  it("a tick saved while the GET was out, with its echo already in, survives the older snapshot", async () => {
    const p = await open([row({ id: "a" })]);
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await settle();
    p.realtime({ eventType: "UPDATE", new: row({ id: "a", completed: true, completed_at: DONE }) });
    p.release("GET items", 200, { items: [row({ id: "a" })] });
    await refreshing;

    expect(p.item("a")?.completed).toBe(true);
  });

  it("an item a collaborator deleted while the GET was out is not brought back by the older snapshot", async () => {
    const p = await open([row({ id: "a" }), row({ id: "b" })]);
    p.hold("GET items");
    const refreshing = p.refresh();
    await settle();

    p.realtime({ eventType: "DELETE", old: { id: "b" } });
    p.release("GET items", 200, { items: [row({ id: "a" }), row({ id: "b" })] });
    await refreshing;

    expect(p.items().map((i) => i.id)).toEqual(["a"]);
  });
});

describe("a realtime UPDATE merges into the screen", () => {
  it("the echo of an older tick does not undo the untick still being saved, and a rename in it shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);
    p.hold("PATCH a");
    const ticking = p.render().handleToggle("a", true);
    await vi.advanceTimersByTimeAsync(200);
    await ticking;
    await p.render().handleToggle("a", false);
    await settle();

    p.realtime({ eventType: "UPDATE", new: row({ id: "a", text: "oat milk", completed: true, completed_at: DONE }) });

    expect(p.item("a")).toMatchObject({ text: "oat milk", completed: false, completed_at: null });
  });

  it("with nothing of the user's pending, the server's row shows", async () => {
    const p = await open([row({ id: "a", text: "milk" })]);

    p.realtime({ eventType: "UPDATE", new: row({ id: "a", text: "milk", completed: true, completed_at: DONE }) });

    expect(p.item("a")).toMatchObject({ completed: true, completed_at: DONE });
  });
});

describe("an added item shows once", () => {
  it("text the server normalizes is shown and sent normalized, so an INSERT that beats the answer replaces the temp row", async () => {
    const p = await open([]);
    p.hold("POST 1");
    await p.render().handleAddItem("Kid’s  cereal");

    expect(p.items().map((i) => i.text)).toEqual(["Kid's cereal"]);
    expect(p.sent.find((s) => s.key === "POST 1")?.body).toMatchObject({ text: "Kid's cereal" });

    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "Kid's cereal" }) });
    expect(p.items().map((i) => i.id)).toEqual(["r1"]);

    p.release("POST 1", 201, { items: [row({ id: "r1", text: "Kid's cereal" })] });
    await settle();
    expect(p.items().map((i) => i.id)).toEqual(["r1"]);
  });

  it("two same-text adds whose echoes and answers interleave leave each saved id once", async () => {
    const p = await open([]);
    p.hold("POST 1");
    p.hold("POST 2");
    await p.render().handleAddItem("milk, milk");
    await settle();

    p.realtime({ eventType: "INSERT", new: row({ id: "r1", text: "milk" }) });
    p.release("POST 1", 201, { items: [row({ id: "r1", text: "milk" })] });
    await settle();
    p.realtime({ eventType: "INSERT", new: row({ id: "r2", text: "milk" }) });
    p.release("POST 2", 201, { items: [row({ id: "r2", text: "milk" })] });
    await settle();

    expect(p.items().map((i) => i.id).sort()).toEqual(["r1", "r2"]);
  });

  it("an item that is only invisible characters is not added", async () => {
    const p = await open([]);
    await p.render().handleAddItem("‎‏");
    await settle();
    expect(p.items()).toEqual([]);
    expect(p.sent.filter((s) => s.key.startsWith("POST"))).toEqual([]);
  });
});

describe("a pending restore-recurring or on the way keeps the item where the user put it (R2)", () => {
  // Completed a minute ago: recent enough that loading the list doesn't respawn it by itself.
  const doneRecurring = () =>
    row({ id: "a", recurring: true, completed: true, completed_at: new Date(Date.now() - 60_000).toISOString(), position: 1 });

  it("a refresh while a restore-recurring is still being saved leaves the item back on the list", async () => {
    const p = await open([doneRecurring()]);
    p.hold("PATCH a");
    p.render().handleRestoreRecurring("a");
    await settle();
    const shown = p.item("a")!;

    p.server.items = [doneRecurring()];
    await p.refresh();

    expect(p.item("a")).toMatchObject({ completed: false, completed_at: null, position: shown.position });
  });

  it("an echo of the item's older state while a restore-recurring is still being saved leaves it back on the list", async () => {
    const p = await open([doneRecurring()]);
    p.hold("PATCH a");
    p.render().handleRestoreRecurring("a");
    await settle();
    const shown = p.item("a")!;

    p.realtime({ eventType: "UPDATE", new: doneRecurring() });

    expect(p.item("a")).toMatchObject({ completed: false, completed_at: null, position: shown.position });
  });

  it("a refresh while an on the way mark is still being saved keeps the mark", async () => {
    const p = await open([row({ id: "a" })]);
    p.hold("PATCH a");
    p.render().handleOrder("a", true);
    await settle();
    const markedAt = p.item("a")!.ordered_at;
    expect(markedAt).not.toBeNull();

    await p.refresh();

    expect(p.item("a")?.ordered_at).toBe(markedAt);
  });

  it("an echo without the mark while an on the way mark is still being saved keeps the mark", async () => {
    const p = await open([row({ id: "a" })]);
    p.hold("PATCH a");
    p.render().handleOrder("a", true);
    await settle();
    const markedAt = p.item("a")!.ordered_at;

    p.realtime({ eventType: "UPDATE", new: row({ id: "a", text: "a2", ordered_at: null }) });

    expect(p.item("a")).toMatchObject({ text: "a2", ordered_at: markedAt });
  });
});
