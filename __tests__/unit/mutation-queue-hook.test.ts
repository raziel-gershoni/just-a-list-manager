/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hook runs as a plain function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useMutationQueue over the real sync engine and executor factory, with a
// slot-based stand-in for React (pattern: restore-skipped-flow.test.ts): refs and memoized
// callbacks persist across renders, effects follow their deps and run during render.
type Slot = { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
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
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const i = R.i++;
      const s = R.slots[i];
      if (s && deps && same(s.deps, deps)) return;
      if (s && typeof s.cleanup === "function") s.cleanup();
      R.slots[i] = { deps, cleanup: fn() };
    },
  };
});

import { useMutationQueue } from "@/src/hooks/useMutationQueue";
import { resetSyncEngines } from "@/src/sync/engine";

const ITEM = "00000000-0000-4000-8000-000000000001";
const storage = new Map<string, string>();
const jwt = { current: null as string | null };
const getJwt = () => jwt.current;
let fetchMock: ReturnType<typeof vi.fn>;

const saved = () => JSON.parse(storage.get("mutation_queue:L") ?? "[]") as { id: string }[];
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
// The list page mounting: two hook instances, as two components on one page would have.
const mount = () => {
  R.slots = [];
  R.i = 0;
  return [useMutationQueue("L", getJwt), useMutationQueue("L", getJwt)];
};

beforeEach(() => {
  resetSyncEngines();
  storage.clear();
  jwt.current = null;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMutationQueue over the sync engine (H3)", () => {
  it("mounting before the token exists sends nothing and keeps every saved change", async () => {
    storage.set(
      "mutation_queue:L",
      JSON.stringify([{ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true }, timestamp: Date.now() }])
    );
    const [q] = mount();
    await q.flushQueue();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved().map((m) => m.id)).toEqual(["m1"]);

    jwt.current = "jwt";
    await q.flushQueue();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer jwt");
    expect(saved()).toEqual([]);
  });

  it("does not flush on mount: replay waits for the page's flush", async () => {
    jwt.current = "jwt";
    storage.set(
      "mutation_queue:L",
      JSON.stringify([{ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true }, timestamp: Date.now() }])
    );
    const [q] = mount();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    await q.flushQueue();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a change made before the token exists is sent once, by the flush after it arrives", async () => {
    const [a, b] = mount();
    a.addMutation({ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true, at: "2026-10-29T08:00:00.000Z" } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    jwt.current = "jwt";
    await Promise.all([a.flushQueue(), b.flushQueue()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(saved()).toEqual([]);
  });
});
