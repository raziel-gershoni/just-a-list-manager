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
  useRef: (init: unknown) => {
    const i = R.i++;
    if (!R.slots[i]) R.slots[i] = { value: { current: init } };
    return R.slots[i].value;
  },
  useCallback: (fn: unknown) => (R.i++, fn),
  useMemo: (fn: () => unknown) => (R.i++, fn()),
  useEffect: () => void R.i++,
}));

const S = vi.hoisted(() => ({
  setListType: (() => {}) as (t: string) => void,
  loadCategories: (async () => {}) as () => Promise<void>,
  listType: "grocery",
  enabled: true,
  setCategoriesEnabled: (() => {}) as (v: boolean) => void,
  clearCategorization: (() => {}) as () => void,
  confirmAnswer: true,
  confirms: [] as string[],
  jwt: "jwt" as string | null,
  refreshItems: (async () => {}) as () => Promise<void>,
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
    jwtRef: { get current() { return S.jwt; } },
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: [], setItems: () => {},
    loading: false, error: false, isShared: false, listType: S.listType, setListType: S.setListType,
    categoriesEnabled: S.enabled, setCategoriesEnabled: S.setCategoriesEnabled, clearCategorization: S.clearCategorization,
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: S.loadCategories, fetchItems: async () => {}, refreshItems: () => S.refreshItems(),
  }),
}));
vi.mock("@/src/types/telegram", async (orig) => ({
  ...(await orig<typeof import("@/src/types/telegram")>()),
  askConfirm: (message: string, onConfirm: () => void) => { S.confirms.push(message); if (S.confirmAnswer) onConfirm(); },
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
import ToastContainer from "@/components/list/ToastContainer";

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

function findText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(findText).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return findText((node as El).props.children);
}

const openSettings = () => {
  const header = find(render(), (el) => el.type === ListHeader);
  (header!.props.onSettings as () => void)();
};
const theSwitch = () => find(render(), (el) => el.props.role === "switch");
const press = () => (theSwitch()!.props.onClick as () => void)();
const categoriesButton = () =>
  find(render(), (el) => el.type === "button" && findText(el) === "categories.manage");

// What the page's error toast says right now.
const errorToast = () => find(render(), (el) => el.type === ToastContainer)!.props.errorToast;

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let patch: { resolve: (r: unknown) => void; reject: (e: unknown) => void };
let fetchMock: ReturnType<typeof vi.fn>;
let loadCategories: ReturnType<typeof vi.fn>;
let refreshItems: ReturnType<typeof vi.fn>;

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
  loadCategories = vi.fn(async () => {});
  S.setCategoriesEnabled = vi.fn();
  S.clearCategorization = vi.fn();
  S.listType = "grocery";
  S.enabled = true;
  S.confirmAnswer = true;
  S.confirms = [];
  S.loadCategories = loadCategories;
  refreshItems = vi.fn(async () => {});
  S.refreshItems = refreshItems;
  S.jwt = "jwt";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the categories switch in list settings", () => {
  const setCats = () => S.setCategoriesEnabled as ReturnType<typeof vi.fn>;
  const clearCats = () => S.clearCategorization as ReturnType<typeof vi.fn>;

  it("shows on a grocery list, checked when categories are on", () => {
    openSettings();
    expect(theSwitch()!.props["aria-checked"]).toBe(true);
    S.enabled = false;
    expect(theSwitch()!.props["aria-checked"]).toBe(false);
  });

  it("is not offered on a regular list", () => {
    S.listType = "regular";
    openSettings();
    expect(theSwitch()).toBeUndefined();
  });

  it("turning off asks first; declining changes and sends nothing", () => {
    S.confirmAnswer = false;
    openSettings();
    press();
    expect(S.confirms).toEqual(["categories.confirmOff"]);
    expect(setCats()).not.toHaveBeenCalled();
    expect(clearCats()).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a confirmed off clears the screen at once, then saves", async () => {
    openSettings();
    press();
    expect(setCats()).toHaveBeenCalledWith(false);
    expect(clearCats()).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clearCats().mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: false });
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(setCats().mock.calls).toEqual([[false]]);
    expect(errorToast()).toBeNull();
  });

  it("an off the server refused turns categories back on, reloads them, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openSettings();
    press();
    patch.resolve({ ok: false, status: 403 });
    await settle();
    expect(setCats().mock.calls).toEqual([[false], [true]]);
    expect(loadCategories).toHaveBeenCalledTimes(1);
    // The screen was cleared locally, so the items come back too, not after the retry's delay.
    expect(refreshItems).toHaveBeenCalledTimes(1);
    expect(errorToast()).toBe("errors.generic");
  });

  it("a failed on refreshes no items", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    S.enabled = false;
    openSettings();
    press();
    patch.resolve({ ok: false, status: 403 });
    await settle();
    expect(refreshItems).not.toHaveBeenCalled();
  });

  it("with no session nothing is sent or changed, and the error toast shows", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    S.jwt = null;
    openSettings();
    press();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setCats()).not.toHaveBeenCalled();
    expect(clearCats()).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("turning on asks nothing and saves", async () => {
    S.enabled = false;
    openSettings();
    press();
    expect(S.confirms).toEqual([]);
    expect(setCats()).toHaveBeenCalledWith(true);
    expect(clearCats()).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: true });
  });

  it("an on that could not be sent turns it back off and says so, reloading nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    S.enabled = false;
    openSettings();
    press();
    patch.reject(new TypeError("Failed to fetch"));
    await settle();
    expect(setCats().mock.calls).toEqual([[true], [false]]);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("the Categories button follows the switch", () => {
    openSettings();
    expect(categoriesButton()).toBeDefined();
    S.enabled = false;
    expect(categoriesButton()).toBeUndefined();
  });
});
