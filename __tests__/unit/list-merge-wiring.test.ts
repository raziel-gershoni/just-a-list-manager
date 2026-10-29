import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ItemData } from "@/src/types";

// Renders the real list page with react-dom/server (node, no DOM). Its data hooks are stubbed:
// useListData hands it items and a refresh, and the stubs of useMutationQueue and
// useListRealtime keep what the page passes them, so a test can call the page's own handlers.
const S = vi.hoisted(() => ({
  items: [] as ItemData[],
  refreshCalls: 0,
  refreshFails: null as Error | null,
  onMutationSuccess: null as null | ((m: { id: string; type: string; payload: Record<string, unknown>; timestamp: number }, result: unknown) => void),
  realtimeArgs: null as null | { onRejoined?: () => void },
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
    onFlushNeededRef: { current: null },
    onResubscribeNeededRef: { current: null },
    onRefreshNeededRef: { current: null },
  }),
}));
vi.mock("@/src/hooks/useListData", () => ({
  useListData: () => ({
    listName: "Groceries", setListName: () => {}, items: S.items,
    setItems: (u: ItemData[] | ((prev: ItemData[]) => ItemData[])) => { S.items = typeof u === "function" ? u(S.items) : u; },
    loading: false, error: false, isShared: false, listType: "regular", setListType: () => {},
    listIcon: null, listColor: null, categories: [], setCategories: () => {},
    loadCategories: async () => {}, fetchItems: async () => {},
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

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function row(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

beforeEach(() => {
  Object.assign(S, { items: [], refreshCalls: 0, refreshFails: null, onMutationSuccess: null, realtimeArgs: null });
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list page's create answer", () => {
  it("drops the temp row when the realtime INSERT already put the saved row on screen", () => {
    S.items = [row({ id: "temp-1", text: "milk", _pending: true }), row({ id: "r1", text: "milk" })];
    S.onMutationSuccess!(
      { id: "m1", type: "create", payload: { listId: "L", text: "milk", tempId: "temp-1" }, timestamp: 0 },
      row({ id: "r1", text: "milk" })
    );
    expect(S.items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("turns the temp row into the saved row otherwise", () => {
    S.items = [row({ id: "temp-1", text: "milk", _pending: true })];
    S.onMutationSuccess!(
      { id: "m1", type: "create", payload: { listId: "L", text: "milk", tempId: "temp-1" }, timestamp: 0 },
      row({ id: "r1", text: "milk" })
    );
    expect(S.items.map((i) => [i.id, i._pending])).toEqual([["r1", false]]);
  });
});

describe("the list page after a realtime rejoin", () => {
  it("refreshes the list to catch up on what it missed", async () => {
    S.realtimeArgs!.onRejoined!();
    await settle();
    expect(S.refreshCalls).toBe(1);
  });

  it("logs a catch-up refresh that fails", async () => {
    const refused = new Error("Background refresh failed: 503");
    S.refreshFails = refused;
    S.realtimeArgs!.onRejoined!();
    await settle();
    expect(console.error).toHaveBeenCalledWith("[List] Catch-up refresh after a realtime rejoin failed:", refused);
  });
});
