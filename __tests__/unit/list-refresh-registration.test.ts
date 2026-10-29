import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemData } from "@/src/types";

// What the list page registers for the reconnect orchestrator. Renders the real page with
// react-dom/server (node, no DOM), runs its effects, and calls what it registered. Its data hooks are stubbed:
// useListData hands it items and a refresh, and the stubs of useMutationQueue and
// useListRealtime keep what the page passes them, so a test can call the page's own handlers.
const S = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  refs: {
    onFlushNeededRef: { current: null as null | (() => Promise<void>) },
    onResubscribeNeededRef: { current: null as null | (() => Promise<void>) },
    onRefreshNeededRef: { current: null as null | (() => Promise<void>) },
  },
  items: [] as ItemData[],
  refreshCalls: 0,
  refreshFails: null as Error | null,
  onMutationSuccess: null as null | ((m: { id: string; type: string; payload: Record<string, unknown>; timestamp: number }, result: unknown) => void),
  realtimeArgs: null as null | { onRejoined?: () => void },
}));

// Effects are collected, and the test runs them after the render (react-dom/server runs none).
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void)) => void S.effects.push(fn),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ id: "L" }) }));
vi.mock("@/components/TelegramProvider", () => ({
  default: ({ children }: { children: unknown }) => children,
  useTelegram: () => ({
    isReady: true,
    jwt: "jwt",
    supabaseClient: null,
    supabaseClientRef: { current: null },
    userId: "u1",
    jwtRef: { current: "jwt" },
    requestTokenRefresh: () => {},
    reconnect: () => {},
    ...S.refs,
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: S.items,
    setItems: (u: ItemData[] | ((prev: ItemData[]) => ItemData[])) => { S.items = typeof u === "function" ? u(S.items) : u; },
    loading: false, error: false, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: async () => {}, fetchItems: async () => true,
    refreshItems: async () => {
      S.refreshCalls++;
      if (S.refreshFails) throw S.refreshFails;
    },
    retrySorting: async () => {},
  }),
}));
vi.mock("@/src/hooks/useSortingRetry", () => ({ useSortingRetry: () => {} }));
vi.mock("@/src/hooks/useMutationQueue", () => ({
  useMutationQueue: (...args: unknown[]) => {
    S.onMutationSuccess = args[4] as typeof S.onMutationSuccess;
    return { addMutation: () => {}, flushQueue: async () => {}, pendingFields: () => new Set<string>() };
  },
}));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({
  useListRealtime: (args: { onRejoined?: () => void }) => {
    S.realtimeArgs = args;
    return { resubscribe: async () => {} };
  },
}));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: () => ({ handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } }),
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/SortableItem", () => ({ default: () => null }));
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

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

beforeEach(async () => {
  Object.assign(S, { items: [row({ id: "a" })], refreshCalls: 0, refreshFails: null, onMutationSuccess: null, realtimeArgs: null, effects: [] });
  Object.assign(S.refs, { onFlushNeededRef: { current: null }, onResubscribeNeededRef: { current: null }, onRefreshNeededRef: { current: null } });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    key: (n: number) => [...storage.keys()][n] ?? null,
    get length() { return storage.size; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  renderToStaticMarkup(createElement(ListPage));
  for (const effect of S.effects) effect();
  // The page's first load works (fetchItems above), so its registered refresh is the merging one.
  for (let k = 0; k < 10; k++) await Promise.resolve();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the refresh the list page registers for the reconnect orchestrator", () => {
  it("is the page's own refresh, so a failed refresh reaches the orchestrator as a failed step", async () => {
    const refused = new Error("Background refresh failed: 503");
    S.refreshFails = refused;
    await expect(S.refs.onRefreshNeededRef.current!()).rejects.toBe(refused);
    expect(S.refreshCalls).toBe(1);
  });

  it("resolves when the refresh works", async () => {
    await expect(S.refs.onRefreshNeededRef.current!()).resolves.toBeUndefined();
  });
});
