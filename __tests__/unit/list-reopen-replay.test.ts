import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Reopening a list with a change still saved from the last session (R3): the real list
// page, useListData, useMutationQueue, sync engine and executor factory against a fake
// server. React is a slot-based stand-in (pattern: list-page-session.test.ts): state persists
// across renders, callbacks, memos and effects follow their deps, and effects run after the
// render that queued them. Realtime, the item handlers and the children are stubbed.
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: (init: unknown) => {
      const i = R.i++;
      if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
      const slot = R.slots[i];
      const set = (u: unknown) => {
        slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u;
      };
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
      R.slots[i] = { deps };
      R.effects.push(() => {
        if (typeof s?.cleanup === "function") s.cleanup();
        R.slots[i].cleanup = fn();
      });
    },
  };
});

// Stable across renders, like the real provider's values.
const T = vi.hoisted(() => ({
  jwtRef: { current: "jwt" as string | null },
  t: (key: string) => key,
  router: { push: () => {} },
  params: { id: "L" },
  refs: { flush: { current: null }, resubscribe: { current: null }, refresh: { current: null } },
  realtime: { resubscribe: async () => {} },
  drag: { handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } },
}));
vi.mock("next-intl", () => ({ useTranslations: () => T.t, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => T.router, useParams: () => T.params }));
vi.mock("@/components/TelegramProvider", () => ({
  useTelegram: () => ({
    isReady: true,
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwt: T.jwtRef.current,
    jwtRef: T.jwtRef,
    reconnect: () => {},
    requestTokenRefresh: () => {},
    onFlushNeededRef: T.refs.flush,
    onResubscribeNeededRef: T.refs.resubscribe,
    onRefreshNeededRef: T.refs.refresh,
  }),
}));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => T.realtime }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({ useListDragDrop: () => T.drag }));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: function CompletedItemsSection() { return null; } }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import { flushAllQueues, resetSyncEngines } from "@/src/sync/engine";
import { createExecutorFactory } from "@/src/utils/executor-factory";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

const render = (): El => {
  R.i = 0;
  R.effects = [];
  const tree = (ListPage as () => El)();
  for (const run of R.effects) run();
  return tree;
};
const flushPromises = async () => {
  for (let k = 0; k < 30; k++) await Promise.resolve();
};
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

const ITEM = "00000000-0000-4000-8000-000000000001";
const storage = new Map<string, string>();
// The server's copy of the list's one item, and every request in the order it went out.
let server: { completed: boolean; text: string };
let requests: string[];
let releasePatch: (() => void) | null;

beforeEach(() => {
  resetSyncEngines();
  R.slots = [];
  storage.clear();
  server = { completed: false, text: "stamps" };
  requests = [];
  releasePatch = null;
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (method === "PATCH" && url === "/api/lists/L/items") {
      // The replayed tick takes a while to land.
      await new Promise<void>((resolve) => (releasePatch = resolve));
      const body = JSON.parse(init!.body!);
      if ("completed" in body) server.completed = body.completed;
      if ("text" in body) server.text = body.text;
      return json({});
    }
    if (url === "/api/lists") return json([{ id: "L", name: "Errands", type: "regular" }]);
    if (url.startsWith("/api/lists/L/items")) {
      return json({
        items: [{
          id: ITEM, text: server.text, completed: server.completed, completed_at: server.completed ? "2026-10-29T08:00:00.000Z" : null,
          deleted_at: null, skipped_at: null, ordered_at: null, recurring: false, position: 1,
        }],
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetSyncEngines();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reopening a list with a change saved from the last session (R3)", () => {
  it("loads the list only after the saved tick landed, so the row shows it ticked", async () => {
    storage.set(
      "mutation_queue:L",
      JSON.stringify([{ id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true, at: "2026-10-29T08:00:00.000Z" }, timestamp: Date.now() }])
    );

    render();
    await flushPromises();
    // The replay is in flight; nothing is read until it settles.
    expect(requests).toEqual(["PATCH /api/lists/L/items"]);

    releasePatch!();
    await flushPromises();
    const tree = render();

    expect(requests).toEqual(["PATCH /api/lists/L/items", "GET /api/lists", "GET /api/lists/L/items?limit=500"]);
    const completed = find(tree, (el) => el.type === CompletedItemsSection)?.props.completedItems as { id: string }[];
    expect(completed.map((i) => i.id)).toEqual([ITEM]);
    expect(storage.get("mutation_queue:L")).toBe("[]");
  });

  it("waits for a replay the provider started first, the change in flight and the one queued behind it", async () => {
    storage.set(
      "mutation_queue:L",
      JSON.stringify([
        { id: "m1", type: "toggle", payload: { listId: "L", itemId: ITEM, completed: true, at: "2026-10-29T08:00:00.000Z" }, timestamp: Date.now() },
        { id: "m2", type: "edit", payload: { listId: "L", itemId: ITEM, text: "stamps x10" }, timestamp: Date.now() },
      ])
    );
    // Web launch / Mini App reload: the stored token starts the provider's replay before the
    // session is ready, so the tick is already in flight when the page's first load starts.
    void flushAllQueues(() => "jwt", createExecutorFactory());
    await flushPromises();
    expect(requests).toEqual(["PATCH /api/lists/L/items"]);

    render();
    await flushPromises();
    expect(requests).toEqual(["PATCH /api/lists/L/items"]);

    releasePatch!();
    await flushPromises();
    // The edit went out behind the tick; the list is still not read.
    expect(requests).toEqual(["PATCH /api/lists/L/items", "PATCH /api/lists/L/items"]);

    releasePatch!();
    await flushPromises();
    const tree = render();

    expect(requests.slice(2)).toEqual(["GET /api/lists", "GET /api/lists/L/items?limit=500"]);
    const completed = find(tree, (el) => el.type === CompletedItemsSection)?.props.completedItems as { id: string; text: string }[];
    expect(completed.map((i) => [i.id, i.text])).toEqual([[ITEM, "stamps x10"]]);
  });
});
