import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import type { ItemData } from "@/src/types";

// The list page opens the item sheet on grocery lists only, and closes it for good when the list
// stops being a grocery list (its type changed on another device). Calls the real page as a plain
// function with slot-based stand-ins for React's hooks (state persists across calls; effects do
// not run). The data hooks and child components are stubbed; their elements keep their props.
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

const S = vi.hoisted(() => ({ listType: "grocery" as string, items: [] as unknown[] }));

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
    listName: "Groceries", setListName: () => {}, items: S.items, setItems: () => {},
    loading: false, error: false, isShared: false, listType: S.listType, setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    categoriesEnabled: true, applyCategoriesSwitch: () => {},
    loadCategories: async () => {}, fetchItems: async () => {}, refreshItems: async () => {},
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
vi.mock("@/components/list/ItemSheet", () => ({ default: () => null }));

import ListPage from "@/app/(app)/list/[id]/page";
import SkippedItemsSection from "@/components/list/SkippedItemsSection";
import ItemSheet from "@/components/list/ItemSheet";

type El = ReactElement<Record<string, unknown> & { children?: unknown }>;
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
const sheet = () => find(render(), (el) => el.type === ItemSheet);

const milk: ItemData = {
  id: "a", text: "Milk", completed: false, completed_at: null, deleted_at: null,
  skipped_at: "2026-11-08T10:00:00.000Z", ordered_at: null, recurring: false, position: 1,
  created_by: null, creator_name: null, edited_by: null, editor_name: null, quantity: "2 L",
};

// Opens Milk's sheet from its row in the Not available section.
function openMilk() {
  const section = find(render(), (el) => el.type === SkippedItemsSection);
  expect(section, "the Not available section").toBeDefined();
  (section!.props.onOpenDetails as (id: string) => void)("a");
}

beforeEach(() => {
  R.slots = [];
  S.listType = "grocery";
  S.items = [milk];
});
afterEach(() => vi.restoreAllMocks());

describe("the item sheet on the list page", () => {
  it("opens on a grocery list for the tapped item", () => {
    expect(sheet()).toBeUndefined();
    openMilk();
    expect(sheet()?.props.item).toBe(milk);
  });

  it("is gone the moment the list stops being a grocery list", () => {
    openMilk();
    S.listType = "regular";
    expect(sheet()).toBeUndefined();
  });

  it("stays closed when the list becomes a grocery list again", () => {
    openMilk();
    S.listType = "regular";
    render();
    S.listType = "grocery";
    expect(sheet()).toBeUndefined();
  });
});
