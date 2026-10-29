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
  data: { error: true, notFound: false },
  fetchItems: (async () => {}) as () => Promise<void>,
  router: { push: (() => {}) as (url: string) => void, replace: (() => {}) as (url: string) => void },
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => S.router, useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    jwt: "jwt",
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
    loading: false, ...S.data, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, setListIcon: () => {}, listColor: null, setListColor: () => {},
    categories: [], setCategories: () => {}, loadCategories: async () => {},
    fetchItems: S.fetchItems, refreshItems: async () => {}, retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: () => ({ addMutation: () => {}, flushQueue: async () => {}, pendingFields: () => new Set() }),
}));
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

// Renders the page down to its first host element: after T1 the default export is the page
// itself (the provider lives in app/(app)/layout.tsx); a wrapper component, if any, is unwrapped.
const render = (): El => {
  R.i = 0;
  let out = (ListPage as unknown as () => El)();
  while (out && typeof out.type === "function") out = (out.type as (p: unknown) => El)(out.props);
  return out;
};

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

const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object" && "props" in node
      ? text((node as El).props.children)
      : typeof node === "string" ? node : "";

// Every button on screen, by its label.
const buttons = () => {
  const out = new Map<string, () => void>();
  for (const b of findAll(render(), (el) => el.type === "button")) out.set(text(b.props.children).trim(), b.props.onClick as () => void);
  return out;
};

let replace: ReturnType<typeof vi.fn>;
let fetchItems: ReturnType<typeof vi.fn>;

beforeEach(() => {
  R.slots = [];
  replace = vi.fn();
  fetchItems = vi.fn(async () => {});
  S.router = { push: vi.fn(), replace };
  S.fetchItems = fetchItems;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the list page when the list can't be opened", () => {
  it("a deleted or unshared list says not found and offers only the way home", () => {
    S.data = { error: true, notFound: true };

    expect(text(render())).toContain("errors.notFound");
    expect(text(render())).not.toContain("lists.loadError");
    expect([...buttons().keys()]).toEqual(["common.goHome"]);

    buttons().get("common.goHome")!();
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("any other load error keeps Retry and also offers the way home", () => {
    S.data = { error: true, notFound: false };

    expect(text(render())).toContain("lists.loadError");
    expect([...buttons().keys()]).toEqual(["common.retry", "common.goHome"]);

    buttons().get("common.retry")!();
    expect(fetchItems).toHaveBeenCalledTimes(1);
    buttons().get("common.goHome")!();
    expect(replace).toHaveBeenCalledWith("/");
  });
});
