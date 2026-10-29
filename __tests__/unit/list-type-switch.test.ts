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
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/CategoriesSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";
import ListHeader from "@/components/list/ListHeader";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import ToastContainer from "@/components/list/ToastContainer";
import { DragDropProvider } from "@dnd-kit/react";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;

// The page component itself: the provider lives in app/(app)/layout.tsx.
const ListContent = ListPage as () => El;

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

function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (match(el)) out.push(el);
  return findAll(el.props.children, match, out);
}

// Opens the settings sheet and presses the button for a list type.
function chooseType(type: string) {
  const header = find(render(), (el) => el.type === ListHeader);
  (header!.props.onSettings as () => void)();
  const button = find(render(), (el) => el.type === "button" && el.key === type);
  expect(button, `the ${type} button`).toBeDefined();
  (button!.props.onClick as () => void)();
}

// What the page's error toast says right now.
const errorToast = () => find(render(), (el) => el.type === ToastContainer)!.props.errorToast;

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
  vi.restoreAllMocks();
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

  it("choosing a non-grocery type loads no categories", async () => {
    chooseType("regular");
    expect(setListType).toHaveBeenCalledWith("regular");
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).not.toHaveBeenCalled();
  });

  it("a switch the server refused puts the old type back, loads nothing, and says so", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    chooseType("grocery");
    patch.resolve({ ok: false, status: 500 });
    await settle();

    expect(setListType.mock.calls).toEqual([["grocery"], ["regular"]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
    expect(errorSpy).toHaveBeenCalledWith(
      "[List] Failed to update list type, listId:", "L", "type:", "grocery",
      expect.objectContaining({ message: "Type change failed: 500" })
    );
  });

  it("a switch that could not be sent puts the old type back and says so, with no unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(setListType.mock.calls).toEqual([["grocery"], ["regular"]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
    expect(unhandled).toEqual([]);
  });

  it("a switch the server accepted keeps the new type and shows no error", async () => {
    chooseType("grocery");
    patch.resolve({ ok: true, status: 200 });
    await settle();

    expect(setListType.mock.calls).toEqual([["grocery"]]);
    expect(errorToast()).toBeNull();
  });
});

describe("the list page", () => {
  it("offers exactly Regular and Grocery in the settings sheet", () => {
    const header = find(render(), (el) => el.type === ListHeader);
    (header!.props.onSettings as () => void)();
    const typeKeys = findAll(render(), (el) => el.type === "button" && typeof el.key === "string" && ["regular", "grocery", "reminders"].includes(el.key)).map((el) => el.key);
    expect(typeKeys).toEqual(["regular", "grocery"]);
  });

  it("renders the drag area and the Done section for a regular list", () => {
    const tree = render();
    expect(find(tree, (el) => el.type === DragDropProvider)).toBeDefined();
    expect(find(tree, (el) => el.type === CompletedItemsSection)).toBeDefined();
  });
});
