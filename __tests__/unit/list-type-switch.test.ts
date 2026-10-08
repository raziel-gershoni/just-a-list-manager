import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real list page component as a plain function with slot-based stand-ins for
// React's hooks (state persists across calls; effects do not run), then presses buttons by
// calling their onClick from the returned element tree. The data hooks are stubbed.
type Slot = { value?: unknown };
const R = vi.hoisted(() => ({ slots: [] as Slot[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = R.slots[i];
    const set = (u: unknown) => { slot.value = typeof u === "function" ? (u as (p: unknown) => unknown)(slot.value) : u; };
    return [slot.value, set];
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: () => void R.i++,
}));

const S = vi.hoisted(() => ({
  setListType: (() => {}) as (t: string) => void,
  loadCategories: (async () => {}) as () => Promise<void>,
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
    jwtRef: { current: "jwt" },
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: [], setItems: () => {},
    loading: false, error: false, isShared: false, listType: "regular", setListType: S.setListType,
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: S.loadCategories, fetchItems: async () => {}, refreshItems: async () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({ useMutationQueue: () => ({ addMutation: () => {}, flushQueue: () => {} }) }));
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
vi.mock("@/components/ReminderSheet", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/list/[id]/page";
import ListHeader from "@/components/list/ListHeader";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// The page's own component: ListPage wraps it in the (stubbed) TelegramProvider.
const ListContent = ((ListPage() as El).props.children as El).type as () => El;

const render = () => {
  R.i = 0;
  return ListContent();
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

// Opens the settings sheet and presses the button for a list type.
function chooseType(type: string) {
  const header = find(render(), (el) => el.type === ListHeader);
  (header!.props.onSettings as () => void)();
  const button = find(render(), (el) => el.type === "button" && el.key === type);
  expect(button, `the ${type} button`).toBeDefined();
  (button!.props.onClick as () => void)();
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let patch: { resolve: (r: unknown) => void; reject: (e: unknown) => void };
let fetchMock: ReturnType<typeof vi.fn>;
let setListType: ReturnType<typeof vi.fn>;
let loadCategories: ReturnType<typeof vi.fn>;

beforeEach(() => {
  R.slots = [];
  fetchMock = vi.fn(
    (url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        if (url !== "/api/lists" || init?.method !== "PATCH") reject(new Error(`unexpected ${url}`));
        patch = { resolve, reject };
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  setListType = vi.fn();
  loadCategories = vi.fn(async () => {});
  S.setListType = setListType;
  S.loadCategories = loadCategories;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switching a list's type in settings", () => {
  it("switching to grocery saves the type, then loads the list's categories", async () => {
    chooseType("grocery");
    expect(setListType).toHaveBeenCalledWith("grocery");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", type: "grocery" });

    // Not before the server has the new type.
    await settle();
    expect(loadCategories).not.toHaveBeenCalled();

    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).toHaveBeenCalledTimes(1);
  });

  it("switching to another type loads no categories", async () => {
    chooseType("reminders");
    expect(setListType).toHaveBeenCalledWith("reminders");
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).not.toHaveBeenCalled();
  });

  it("a switch that could not be sent loads nothing and fails quietly", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      chooseType("grocery");
      patch.reject(new TypeError("Failed to fetch"));
      await settle();
      // Node reports an unhandled rejection on a later turn of the event loop.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(loadCategories).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
