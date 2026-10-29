import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real list page, with the real useListData, as a plain function with slot-based
// stand-ins for React's hooks: state persists across renders, callbacks, memos and effects
// follow their deps, and effects run after the render that queued them. The session comes
// from a stubbed useTelegram the test changes between renders; the other hooks and the
// children are stubbed.
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
  isReady: false,
  jwtRef: { current: null as string | null },
  t: (key: string) => key,
  router: { push: () => {} },
  params: { id: "L" },
  refs: { flush: { current: null }, resubscribe: { current: null }, refresh: { current: null } },
  queue: { addMutation: () => {}, flushQueue: async () => {} },
  realtime: { resubscribe: async () => {} },
  drag: { handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } },
}));
vi.mock("next-intl", () => ({ useTranslations: () => T.t, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => T.router, useParams: () => T.params }));
vi.mock("@/components/TelegramProvider", () => ({
  useTelegram: () => ({
    isReady: T.isReady,
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwtRef: T.jwtRef,
    onFlushNeededRef: T.refs.flush,
    onResubscribeNeededRef: T.refs.resubscribe,
    onRefreshNeededRef: T.refs.refresh,
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({ useMutationQueue: () => T.queue }));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => T.realtime }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({ useListDragDrop: () => T.drag }));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: function OfflineIndicator() { return null; } }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: function ListHeader() { return null; } }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";
import OfflineIndicator from "@/components/OfflineIndicator";
import ListHeader from "@/components/list/ListHeader";
import AddItemInput from "@/components/AddItemInput";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

const render = (): El => {
  R.i = 0;
  R.effects = [];
  const tree = (ListPage as () => El)();
  for (const run of R.effects) run();
  return tree;
};
// Renders (running effects), lets the page's requests finish, and renders the result.
const settle = async (): Promise<El> => {
  render();
  for (let k = 0; k < 30; k++) await Promise.resolve();
  return render();
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
const has = (tree: El, type: unknown) => find(tree, (el) => el.type === type) !== undefined;
const hasText = (tree: El, text: string) => find(tree, (el) => el.props.children === text) !== undefined;
const skeleton = (tree: El) => find(tree, (el) => String(el.props.className).includes("skeleton-shimmer")) !== undefined;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  R.slots = [];
  T.isReady = false;
  T.jwtRef.current = null;
  fetchMock = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/lists") return json([{ id: "L", name: "Groceries", type: "regular" }]);
    if (url.startsWith("/api/lists/L/items")) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list page while the session signs in (H10)", () => {
  it("keeps its placeholders, with the connection banner, until the session settles", async () => {
    const tree = await settle();
    expect(skeleton(tree)).toBe(true);
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a JWT once the sign-in gave up, leaves the placeholders for the error screen and its banner", async () => {
    await settle();
    T.isReady = true;
    const tree = await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skeleton(tree)).toBe(false);
    expect(hasText(tree, "lists.loadError")).toBe(true);
    expect(has(tree, OfflineIndicator)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[List] Load skipped, no session:", { listId: "L" });
  });

  it("loads the list when a later retry brings a JWT", async () => {
    T.isReady = true;
    await settle(); // gave up: the error screen
    T.isReady = false; // the manual retry restarts the sign-in
    await settle();
    T.jwtRef.current = "jwt";
    T.isReady = true;

    const tree = await settle();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/lists", "/api/lists/L/items?limit=500"]);
    expect(has(tree, ListHeader)).toBe(true);
    expect(hasText(tree, "lists.loadError")).toBe(false);
  });
});

describe("a list whose first load failed, once the connection is back (C27)", () => {
  // The lists answer 500 until `lists` is flipped; the items answer follows `itemsOk`.
  let listsOk = false;
  const stubServer = () => {
    fetchMock.mockImplementation(async (url: string) => {
      const json = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body });
      if (url === "/api/lists") return json(listsOk, [{ id: "L", name: "Groceries", type: "regular" }]);
      if (url.startsWith("/api/lists/L/items")) return json(true, { items: [{ id: "i1", text: "Milk", completed: false, recurring: false, position: 1 }] });
      throw new Error(`unexpected ${url}`);
    });
  };
  const refresh = () => (T.refs.refresh.current as unknown as () => Promise<void>)();
  const header = (tree: El) => find(tree, (el) => el.type === ListHeader);
  const shownItems = (tree: El) => find(tree, (el) => el.type === AddItemInput)?.props.items as unknown[] | undefined;

  beforeEach(() => {
    listsOk = false;
    stubServer();
    vi.spyOn(console, "error").mockImplementation(() => {});
    T.jwtRef.current = "jwt";
    T.isReady = true;
  });

  it("the load fails with a token: the error screen shows", async () => {
    const tree = await settle();
    expect(hasText(tree, "lists.loadError")).toBe(true);
    expect(header(tree)).toBeUndefined();
  });

  it("the refresh the page registers loads the list, so the error screen goes", async () => {
    await settle();
    listsOk = true;
    await refresh();
    const tree = await settle();
    expect(hasText(tree, "lists.loadError")).toBe(false);
    expect(header(tree)?.props.listName).toBe("Groceries");
    expect(shownItems(tree)).toHaveLength(1);
  });

  it("the refresh the page registers rejects while the load still fails, so the reconnect retries", async () => {
    await settle();
    await expect(refresh()).rejects.toThrow();
    expect(hasText(await settle(), "lists.loadError")).toBe(true);
  });

  it("a first load that finds the list gone: the registered refresh resolves and the not-found view stays", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const json = (ok: boolean, status: number, body: unknown) => ({ ok, status, json: async () => body });
      if (url.startsWith("/api/lists/L/items")) return json(false, 403, { error: "Forbidden" });
      if (url.startsWith("/api/lists")) return json(true, 200, []);
      throw new Error(`unexpected ${url}`);
    });
    expect(hasText(await settle(), "errors.notFound")).toBe(true);
    // Retrying can never clear it, so the reconnect must not spin its retry loop over it.
    await expect(refresh()).resolves.toBeUndefined();
    const tree = await settle();
    expect(hasText(tree, "errors.notFound")).toBe(true);
    expect(header(tree)).toBeUndefined();
  });

  it("after one good load the registered refresh only merges items", async () => {
    listsOk = true;
    await settle();
    fetchMock.mockClear();
    await refresh();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/lists/L/items?limit=500"]);
  });
});
