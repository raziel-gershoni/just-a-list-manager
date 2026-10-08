/* eslint-disable react-hooks/rules-of-hooks -- react is stubbed below; the hooks run as plain functions */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Runs the real useMutationQueue, useItemHandlers and executor factory against an
// in-memory fake server. The hooks only use useRef/useCallback/useMemo/useEffect, so a
// minimal slot-based stand-in for React runs them in node: state persists across
// renders, memoized values and effects follow their deps, and effects run (and clean
// up) synchronously during render. Nothing here renders to a DOM.
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

import { useMutationQueue } from "@/src/hooks/useMutationQueue";
import { useItemHandlers } from "@/src/hooks/useItemHandlers";
import { createExecutorFactory } from "@/src/utils/executor-factory";
import type { ItemData } from "@/src/types";

const SKIPPED_AT = "2026-10-08T08:00:00.000Z";

type Row = { id: string; skipped_at: string | null };
type Behavior = "ok" | "neterr" | 500 | "hold";

function toItem(r: Row): ItemData {
  return {
    id: r.id, text: r.id, completed: false, completed_at: null, deleted_at: null,
    skipped_at: r.skipped_at, ordered_at: null, recurring: false, position: 1,
    created_by: null, creator_name: null, edited_by: null, editor_name: null,
  };
}

// Let queued promise chains run without moving the clock.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// A grocery list with milk and eggs under Not available and bread active.
function world(opts: { extraItems?: ItemData[] } = {}) {
  const server = new Map<string, Row>([
    ["milk", { id: "milk", skipped_at: SKIPPED_AT }],
    ["eggs", { id: "eggs", skipped_at: SKIPPED_AT }],
    ["bread", { id: "bread", skipped_at: null }],
  ]);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", { onLine: true });
  const listeners = new Map<string, (() => void)[]>();
  const on = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const off = (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
  const doc = { visibilityState: "visible", addEventListener: on, removeEventListener: off };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener: on, removeEventListener: off });

  // Per-request behaviors, consumed in order; default "ok". Keys: "unskip-all" or "PATCH <id>".
  const behaviors = new Map<string, Behavior[]>();
  const held = new Map<string, () => void>();
  const log: string[] = [];
  const apply = (key: string, body: { itemIds?: string[]; itemId?: string; skipped?: boolean }) => {
    if (key === "unskip-all") {
      if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
        log.push("unskip-all 400"); // mirrors the route's validation
        return { ok: false, status: 400, json: async () => ({}) };
      }
      for (const id of body.itemIds) {
        const r = server.get(id);
        if (r && r.skipped_at) r.skipped_at = null;
      }
      log.push(`unskip-all ${body.itemIds.join(",")}`);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    log.push(`PATCH ${body.itemId} skipped=${body.skipped}`);
    const r = server.get(body.itemId!);
    if (!r) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof body.skipped === "boolean") r.skipped_at = body.skipped ? new Date().toISOString() : null;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const body = JSON.parse(init.body ?? "{}");
    const key = url.endsWith("/items/unskip-all") ? "unskip-all" : `${init.method} ${body.itemId}`;
    const behavior = behaviors.get(key)?.shift() ?? "ok";
    if (behavior === "neterr") { log.push(`${key} neterr`); throw new TypeError("Failed to fetch"); }
    if (behavior === 500) { log.push(`${key} 500`); return { ok: false, status: 500, json: async () => ({}) }; }
    if (behavior === "hold") await new Promise<void>((resolve) => held.set(key, resolve));
    return apply(key, body);
  }));

  let items: ItemData[] = [...[...server.values()].map(toItem), ...(opts.extraItems ?? [])];
  const setItems = (u: ItemData[] | ((p: ItemData[]) => ItemData[])) => {
    items = typeof u === "function" ? u(items) : u;
  };
  type Undo = { undo: () => void; message: string } | null;
  let undoAction: Undo = null;
  const setUndoAction = (u: Undo | ((p: Undo) => Undo)) => {
    undoAction = typeof u === "function" ? u(undoAction) : u;
  };

  // The list page: both hooks in one component, re-rendered with the latest items.
  const jwtRef = { current: "jwt" };
  const factory = createExecutorFactory();
  const noop = () => {};
  const t = (k: string) => k;
  const getJwt = () => "jwt"; // stable, like the page's useCallback
  const render = () => {
    R.i = 0;
    const q = useMutationQueue("L", getJwt, factory, noop);
    const h = useItemHandlers({
      listId: "L", jwtRef, userId: "u", items, setItems,
      addMutation: q.addMutation, setUndoAction,
      setDuplicateWarning: noop, setReminderToast: noop, setErrorToast: noop,
      listType: "grocery", t,
    } as unknown as Parameters<typeof useItemHandlers>[0]);
    return { q, h };
  };
  const { q, h } = render();
  // Reopening the app: a fresh mount over the same storage.
  const makeQueue = () => {
    R.slots = [];
    return render().q;
  };

  return {
    server, q, makeQueue, h, log,
    when: (key: string, ...b: Behavior[]) => behaviors.set(key, b),
    release: (key: string) => held.get(key)!(),
    hide: (event: "visibilitychange" | "pagehide") => {
      doc.visibilityState = "hidden";
      for (const fn of listeners.get(event) ?? []) fn();
    },
    undoAction: () => undoAction,
    unmount: () => {
      for (const slot of R.slots) if (typeof slot?.cleanup === "function") slot.cleanup();
    },
    setLocal: (row: Row) => setItems((prev) => [...prev.filter((i) => i.id !== row.id), toItem(row)]),
    item: (id: string) => items.find((i) => i.id === id)!,
    serverState: (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, server.get(id)!.skipped_at ? "skipped" : "active"])),
    clientState: (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, items.find((i) => i.id === id)!.skipped_at ? "skipped" : "active"])),
    queued: () => (JSON.parse(storage.get("mutation_queue:L") ?? "[]") as { type: string }[]).map((m) => m.type),
    // React re-renders after setItems; handlers read items from the latest render.
    rerender: () => render().h,
  };
}

beforeEach(() => {
  R.slots = [];
  R.i = 0;
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Restore all on Not available", () => {
  it("restores on screen and sends one request for exactly those items at once, with no undo", async () => {
    const w = world();
    w.h.handleRestoreSkipped();
    expect(w.clientState("milk", "eggs", "bread")).toEqual({ milk: "active", eggs: "active", bread: "active" });
    await settle();

    expect(w.log).toEqual(["unskip-all milk,eggs"]);
    expect(w.serverState("milk", "eggs", "bread")).toEqual({ milk: "active", eggs: "active", bread: "active" });
    expect(w.queued()).toEqual([]);
    expect(w.undoAction()).toBeNull();
  });

  it("does nothing when no item is skipped", async () => {
    const w = world();
    w.h.handleRestoreSkipped();
    await settle();
    w.rerender().handleRestoreSkipped();
    await settle();

    expect(w.log).toEqual(["unskip-all milk,eggs"]);
  });

  it("a server error keeps the restore queued, and the retry restores the items", async () => {
    const w = world();
    w.when("unskip-all", 500);
    w.h.handleRestoreSkipped();
    await settle();
    expect(w.queued()).toEqual(["unskip-all"]);
    expect(w.serverState("milk", "eggs")).toEqual({ milk: "skipped", eggs: "skipped" });

    await w.q.flushQueue();
    await settle();

    expect(w.log).toEqual(["unskip-all 500", "unskip-all milk,eggs"]);
    expect(w.serverState("milk", "eggs")).toEqual({ milk: "active", eggs: "active" });
    expect(w.queued()).toEqual([]);
  });

  it("a restore that could not be sent is replayed with its item ids when the app is reopened", async () => {
    const w = world();
    w.when("unskip-all", "neterr");
    w.h.handleRestoreSkipped();
    await settle();
    expect(w.queued()).toEqual(["unskip-all"]);

    // Meanwhile a collaborator marks bread Not available; the replay must leave it alone.
    w.server.get("bread")!.skipped_at = SKIPPED_AT;
    await w.makeQueue().flushQueue();
    await settle();

    expect(w.log).toContain("unskip-all milk,eggs");
    expect(w.serverState("milk", "eggs", "bread")).toEqual({ milk: "active", eggs: "active", bread: "skipped" });
    expect(w.queued()).toEqual([]);
  });

  it("an item still waiting for its offline create is restored through its own skip mutation, queued at tap time", async () => {
    const pending = { ...toItem({ id: "temp-1-0.5", skipped_at: SKIPPED_AT }), _pending: true };
    const w = world({ extraItems: [pending] });
    w.when("PATCH temp-1-0.5", "neterr");
    w.h.handleRestoreSkipped();
    expect(w.clientState("temp-1-0.5")).toEqual({ "temp-1-0.5": "active" });
    await settle();

    expect(w.log).toContain("unskip-all milk,eggs");
    // Queued behind its create, so the queue can swap in the real id before sending.
    expect(w.queued()).toEqual(["skip"]);
  });
});
