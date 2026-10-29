import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import type { ItemData } from "@/src/types";

// Calls the real list page as a plain function with slot-based stand-ins for React's hooks:
// state persists across renders, effects are recorded and run by the test. The data hooks
// are stubbed; useMutationQueue records what the page hands the sync engine.
type Slot = { value?: unknown };
type Effect = { fn: () => void | (() => void); deps?: unknown[] };
const R = vi.hoisted(() => ({ slots: [] as Slot[], effects: [] as Effect[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = R.slots[i];
    const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
    return [slot.value, set];
  },
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: fn() };
    return R.slots[i].value;
  },
  useEffect: (fn: Effect["fn"], deps?: unknown[]) => {
    R.i++;
    R.effects.push({ fn, deps });
  },
}));

const S = vi.hoisted(() => ({
  jwt: null as string | null,
  items: [] as ItemData[],
  requestTokenRefresh: () => {},
  flushQueue: null as unknown as ReturnType<typeof vi.fn>,
  fetchItems: null as unknown as ReturnType<typeof vi.fn>,
  refreshItems: null as unknown as ReturnType<typeof vi.fn>,
  queueArgs: [] as unknown[],
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwt: S.jwt,
    jwtRef: { current: S.jwt },
    requestTokenRefresh: S.requestTokenRefresh,
    reconnect: () => {},
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {},
    items: S.items,
    setItems: (u: ItemData[] | ((p: ItemData[]) => ItemData[])) => { S.items = typeof u === "function" ? u(S.items) : u; },
    loading: false, error: false, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: async () => {}, fetchItems: S.fetchItems, refreshItems: S.refreshItems, retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: (...args: unknown[]) => {
    S.queueArgs = args;
    return { addMutation: () => {}, flushQueue: S.flushQueue, pendingFields: () => new Set() };
  },
}));
const ENGINE = vi.hoisted(() => ({ pending: new Set<string>() }));
vi.mock("@/src/sync/engine", () => ({ getSyncEngine: () => ({ pendingFields: () => ENGINE.pending }) }));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => ({ resubscribe: () => {} }) }));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: () => null }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
vi.mock("@/components/ItemRow", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// Renders the component that calls the page's hooks: the default export itself, or the one
// it wraps.
function render() {
  R.i = 0;
  R.effects = [];
  const out = (ListPage as () => El)();
  if (R.i > 0) return;
  const child = out.props.children as El | undefined;
  const inner = (child && typeof child.type === "function" ? child.type : out.type) as () => El;
  R.i = 0;
  R.effects = [];
  inner();
}
const runEffects = () => {
  for (const e of R.effects) e.fn();
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
type OnError = (info: { mutationId: string; type: string; httpStatus: number | null; message: string; dropped: boolean; payload: Record<string, unknown> }) => void;
const onError = () => S.queueArgs[3] as OnError;
const onSuccess = () => S.queueArgs[4] as (m: unknown, result: unknown) => void;

const item = (over: Partial<ItemData> & { id: string }): ItemData => ({
  text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
  recurring: false, position: 1, created_by: "u1", creator_name: null, edited_by: null, editor_name: null, ...over,
});

beforeEach(() => {
  R.slots = [];
  S.jwt = null;
  S.items = [];
  S.queueArgs = [];
  S.flushQueue = vi.fn(async () => {});
  S.fetchItems = vi.fn(async () => {});
  S.refreshItems = vi.fn(async () => {});
  ENGINE.pending = new Set();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the list page and its sync engine", () => {
  it("flushes the list's saved changes once a token exists, not before (H3)", () => {
    render();
    runEffects();
    expect(S.flushQueue).not.toHaveBeenCalled();

    S.jwt = "jwt";
    render();
    runEffects();
    expect(S.flushQueue).toHaveBeenCalledOnce();
  });

  it("loads the list only after its saved changes replayed (R3)", async () => {
    let replayed!: () => void;
    S.flushQueue = vi.fn(() => new Promise<void>((resolve) => (replayed = resolve)));
    S.jwt = "jwt";
    render();
    runEffects();
    await settle();
    expect(S.flushQueue).toHaveBeenCalledOnce();
    expect(S.fetchItems).not.toHaveBeenCalled();

    replayed();
    await settle();
    expect(S.fetchItems).toHaveBeenCalledOnce();
  });

  it("a renewed token replays what is still saved, without reloading the list (R3)", async () => {
    S.jwt = "jwt";
    render();
    runEffects();
    await settle();
    expect(S.fetchItems).toHaveBeenCalledOnce();

    S.jwt = "jwt-renewed";
    render();
    runEffects();
    await settle();
    expect(S.flushQueue).toHaveBeenCalledTimes(2);
    expect(S.fetchItems).toHaveBeenCalledOnce();
  });

  it("re-reads the list after a dropped change, one refresh at a time (H17)", async () => {
    let finish: () => void = () => {};
    S.refreshItems = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render();
    const drop = { mutationId: "m1", type: "toggle", httpStatus: 400, message: "Toggle failed: 400", dropped: true, payload: { itemId: "i1" } };

    onError()(drop);
    onError()({ ...drop, mutationId: "m2" });
    onError()({ ...drop, mutationId: "m3" });
    expect(S.refreshItems).toHaveBeenCalledOnce();

    finish();
    await settle();
    expect(S.refreshItems).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a change kept for retry", () => {
    render();
    onError()({ mutationId: "m1", type: "toggle", httpStatus: 503, message: "Toggle failed: 503", dropped: false, payload: {} });
    expect(S.refreshItems).not.toHaveBeenCalled();
  });

  it("a landed create keeps the tick made on the item before its create answered (H5)", () => {
    S.items = [item({ id: "temp-1", text: "milk", completed: true, completed_at: "2026-10-29T08:00:00.000Z", position: 99, _pending: true })];
    ENGINE.pending = new Set(["completed", "completed_at"]);
    render();

    onSuccess()(
      { id: "m1", type: "create", payload: { listId: "L", tempId: "temp-1", text: "milk" }, timestamp: 0 },
      item({ id: "real-1", text: "milk", position: 7, category_id: "dairy" })
    );

    expect(S.items).toEqual([
      expect.objectContaining({
        id: "real-1", text: "milk", position: 7, category_id: "dairy",
        completed: true, completed_at: "2026-10-29T08:00:00.000Z", _pending: false,
      }),
    ]);
  });

  it("a landed recycle shows the server's row, back at the top", () => {
    S.items = [item({ id: "a", text: "milk", position: 1 }), item({ id: "b", text: "bread", position: 5 })];
    render();

    onSuccess()(
      { id: "m1", type: "recycle", payload: { listId: "L", recycleId: "a", text: "milk" }, timestamp: 0 },
      item({ id: "a", text: "milk", position: 6 })
    );

    expect(S.items.find((i) => i.id === "a")).toMatchObject({ position: 6, completed: false });
  });

  it("asks for a fresh token when the engine reports a 401", () => {
    S.requestTokenRefresh = vi.fn();
    render();
    expect(S.queueArgs[5]).toBe(S.requestTokenRefresh);
  });
});
