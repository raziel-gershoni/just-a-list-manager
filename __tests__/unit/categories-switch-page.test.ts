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
  applyCategoriesSwitch: (() => {}) as (v: boolean) => void,
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
    categoriesEnabled: S.enabled, applyCategoriesSwitch: S.applyCategoriesSwitch,
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
import CategoriesSheet from "@/components/list/CategoriesSheet";

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
const typeButton = (label: string) => find(render(), (el) => el.type === "button" && findText(el) === label);
const theSheet = () => find(render(), (el) => el.type === CategoriesSheet);

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
  S.applyCategoriesSwitch = vi.fn();
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
  const applied = () => S.applyCategoriesSwitch as ReturnType<typeof vi.fn>;

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
    expect(applied()).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a confirmed off shows at once, then saves", async () => {
    openSettings();
    press();
    expect(applied().mock.calls).toEqual([[false]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(applied().mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: false });
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(applied().mock.calls).toEqual([[false]]);
    expect(refreshItems).not.toHaveBeenCalled();
    expect(errorToast()).toBeNull();
  });

  it("an off the server refused turns categories back on, re-reads the list once, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openSettings();
    press();
    patch.resolve({ ok: false, status: 403 });
    await settle();
    expect(applied().mock.calls).toEqual([[false], [true]]);
    // The re-read carries the server's real switch and loads the categories when it is on.
    expect(refreshItems).toHaveBeenCalledTimes(1);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("with no session nothing is sent or changed, and the error toast shows", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    S.jwt = null;
    openSettings();
    press();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applied()).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("turning on asks nothing and saves", async () => {
    S.enabled = false;
    openSettings();
    press();
    expect(S.confirms).toEqual([]);
    expect(applied().mock.calls).toEqual([[true]]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "L", categoriesEnabled: true });
  });

  it("an on that could not be sent turns it back off, re-reads the list once, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    S.enabled = false;
    openSettings();
    press();
    patch.reject(new TypeError("Failed to fetch"));
    await settle();
    expect(applied().mock.calls).toEqual([[true], [false]]);
    // The save may have committed with its answer lost: the re-read shows the server's switch.
    expect(refreshItems).toHaveBeenCalledTimes(1);
    expect(loadCategories).not.toHaveBeenCalled();
    expect(errorToast()).toBe("errors.generic");
  });

  it("the Categories button follows the switch", () => {
    openSettings();
    expect(categoriesButton()).toBeDefined();
    S.enabled = false;
    expect(categoriesButton()).toBeUndefined();
  });

  it("an open Categories sheet closes when categories go off, here or on another device", () => {
    openSettings();
    (categoriesButton()!.props.onClick as () => void)();
    expect(theSheet()).toBeDefined();
    S.enabled = false;
    expect(theSheet()).toBeUndefined();
  });

  it("an open Categories sheet closes when the list stops being a grocery list", () => {
    openSettings();
    (categoriesButton()!.props.onClick as () => void)();
    expect(theSheet()).toBeDefined();
    S.listType = "regular";
    expect(theSheet()).toBeUndefined();
  });

  it("a sheet an off closed stays closed when categories come back on", () => {
    openSettings();
    (categoriesButton()!.props.onClick as () => void)();
    S.enabled = false;
    expect(theSheet()).toBeUndefined();
    S.enabled = true;
    expect(theSheet()).toBeUndefined();
  });

  it("a sheet a type change closed stays closed when the list is grocery again", () => {
    openSettings();
    (categoriesButton()!.props.onClick as () => void)();
    S.listType = "regular";
    expect(theSheet()).toBeUndefined();
    S.listType = "grocery";
    expect(theSheet()).toBeUndefined();
  });
});

describe("the list type control", () => {
  it("a switch to grocery loads the categories when they are on", async () => {
    S.listType = "regular";
    openSettings();
    (typeButton("lists.typeGrocery")!.props.onClick as () => void)();
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).toHaveBeenCalledTimes(1);
  });

  it("a switch to grocery on a list with categories off loads none", async () => {
    S.listType = "regular";
    S.enabled = false;
    openSettings();
    (typeButton("lists.typeGrocery")!.props.onClick as () => void)();
    patch.resolve({ ok: true, status: 200 });
    await settle();
    expect(loadCategories).not.toHaveBeenCalled();
  });
});
