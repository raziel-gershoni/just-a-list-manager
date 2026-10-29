/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useItemHandlers only uses useCallback, and React's own throws outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
}));

import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { getSyncEngine } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { ItemData } from "@/src/types";

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

// The engine registry is module-level, one engine per list: every test gets a list of its own.
let lists = 0;

// The list page around the real handlers, the real engine and the real executor factory.
// The fake server keeps which items are soft-deleted; `log` is every request it answered,
// in order, as "<METHOD> <itemId> -> <status | neterr>".
function world(initial: ItemData[]) {
  const listId = `undo-${++lists}`;
  let items = initial;
  let undoAction: Undo = null;
  const deleted = new Set<string>();
  const replies = new Map<string, Reply[]>();
  // A request that keeps failing the same way until `up` (a retry while still down fails too).
  const failing = new Map<string, Reply>();
  const held = new Map<string, (status: number) => void>();
  const log: string[] = [];

  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const itemId = init.method === "DELETE" ? new URL(url, "http://app").searchParams.get("itemId")! : body.itemId;
    const key = `${init.method} ${itemId}`;
    const reply = failing.get(key) ?? replies.get(key)?.shift() ?? 200;
    if (reply === "neterr") {
      log.push(`${key} -> neterr`);
      throw new TypeError("Failed to fetch");
    }
    const status = reply === "hold" ? await new Promise<number>((resolve) => held.set(key, resolve)) : reply;
    log.push(`${key} -> ${status}`);
    if (status === 200 && init.method === "DELETE") deleted.add(itemId);
    if (status === 200 && init.method === "PATCH" && body.deleted_at === null) deleted.delete(itemId);
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  }));

  const engine = getSyncEngine(listId);
  const onError = vi.fn();
  const detach = engine.attach({ getJwt: () => "jwt", executorFactory: createExecutorFactory(), onError });

  const h = () =>
    useItemHandlers({
      listId,
      jwtRef: { current: "jwt" },
      userId: "u",
      items,
      setItems: (u) => { items = typeof u === "function" ? u(items) : u; },
      addMutation: (m) => engine.add(m),
      setUndoAction: (u) => { undoAction = typeof u === "function" ? u(undoAction) : u; },
      setDuplicateWarning: () => {},
      setReminderToast: () => {},
      setErrorToast: () => {},
      t: (key) => key,
    });

  return {
    h,
    engine,
    detach,
    onError,
    log,
    deleted,
    when: (key: string, ...r: Reply[]) => replies.set(key, r),
    down: (key: string, reply: Reply) => failing.set(key, reply),
    up: (key: string) => failing.delete(key),
    release: (key: string, status: number) => held.get(key)!(status),
    undo: () => undoAction!.undo(),
    ids: () => items.map((i) => i.id).sort(),
  };
}

// The restore of `id` went out only after a delete of it had landed, and the item ended live.
function restoredAfterDelete(log: string[], deleted: Set<string>, id: string) {
  const landed = log.indexOf(`DELETE ${id} -> 200`);
  const firstPatch = log.findIndex((l) => l.startsWith(`PATCH ${id} `));
  expect(landed).toBeGreaterThan(-1);
  expect(firstPatch).toBeGreaterThan(landed);
  expect(log.slice(landed + 1).some((l) => l.startsWith(`DELETE ${id} `))).toBe(false);
  expect(deleted.has(id)).toBe(false);
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};

// A flush that may wait on timers of its own (backoff) still completes under fake timers.
const flushed = async (engine: { flush(): Promise<void> }) => {
  const done = engine.flush();
  await settle();
  await done;
  await settle();
};

let detach: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { onLine: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  detach?.();
  detach = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Undo of a delete always lands after the delete", () => {
  it("a delete kept for retry (503) is replayed before the restore, so the item stays on the server", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.down("DELETE b", 503);

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    // The restore waits behind the delete that is waiting for its retry.
    expect(w.log.some((l) => l.startsWith("PATCH b "))).toBe(false);

    w.up("DELETE b");
    await flushed(w.engine);

    expect(w.log[0]).toBe("DELETE b -> 503");
    restoredAfterDelete(w.log, w.deleted, "b");
    expect(w.ids()).toEqual(["a", "b"]);
    expect(w.onError).not.toHaveBeenCalledWith(expect.objectContaining({ dropped: true }));
  });

  it("an Undo tapped while the delete is in flight is sent only after the delete answered", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.when("DELETE b", "hold");

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    expect(w.log).toEqual([]);

    w.release("DELETE b", 200);
    await settle();

    expect(w.log).toEqual(["DELETE b -> 200", "PATCH b -> 200"]);
    restoredAfterDelete(w.log, w.deleted, "b");
  });

  it("an Undo made offline is kept and replayed in order once the network is back", async () => {
    const w = world([item({ id: "a" }), item({ id: "b" })]);
    detach = w.detach;
    w.down("DELETE b", "neterr");
    w.down("PATCH b", "neterr");

    await w.h().handleDelete("b");
    await settle();
    w.undo();
    await settle();
    expect(w.ids()).toEqual(["a", "b"]);

    w.up("DELETE b");
    w.up("PATCH b");
    await flushed(w.engine);

    expect(w.log[0]).toBe("DELETE b -> neterr");
    restoredAfterDelete(w.log, w.deleted, "b");
  });

  it("Undo of Remove duplicates restores each duplicate after its own delete", async () => {
    const w = world([
      item({ id: "m1", text: "milk", position: 3 }),
      item({ id: "m2", text: "milk", position: 2 }),
      item({ id: "m3", text: "milk", position: 1 }),
    ]);
    detach = w.detach;
    w.down("DELETE m2", 503);
    w.down("DELETE m3", 503);

    w.h().handleRemoveDuplicates("milk");
    await settle();
    w.undo();
    await settle();
    w.up("DELETE m2");
    w.up("DELETE m3");
    await flushed(w.engine);

    restoredAfterDelete(w.log, w.deleted, "m2");
    restoredAfterDelete(w.log, w.deleted, "m3");
    expect(w.ids()).toEqual(["m1", "m2", "m3"]);
  });
});
