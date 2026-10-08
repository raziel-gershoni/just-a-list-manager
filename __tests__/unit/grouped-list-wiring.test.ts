import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Children, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CategoryGroup, ItemData, ListCategory } from "@/src/types";

const page = readFileSync(resolve(process.cwd(), "app/list/[id]/page.tsx"), "utf8");
const sortable = readFileSync(resolve(process.cwd(), "components/SortableItem.tsx"), "utf8");

describe("grouped grocery list wiring", () => {
  it("derives category groups only for grocery lists, with the viewer's locale", () => {
    const at = page.indexOf("useListDerivedData(");
    const call = page.slice(at, page.indexOf(");", at));
    expect(call).toMatch(/grouped: listType === "grocery"/);
    expect(call).toMatch(/categories/);
    expect(call).toMatch(/locale/);
  });

  it("hands the groups to the drag hook", () => {
    const at = page.indexOf("useListDragDrop({");
    expect(page.slice(at, page.indexOf("})", at))).toMatch(/groups: categoryGroups/);
  });

  it("renders each group's header and its rows with their group and in-group index", () => {
    const at = page.indexOf("categoryGroups.flatMap(");
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, page.indexOf("</DragDropProvider>", at));
    expect(block).toMatch(/group\.label/);
    expect(block).toMatch(/group=\{group\.key\}/);
    expect(block).toMatch(/index=\{indexInGroup\}/);
    expect(block).toMatch(/disabled=\{group\.key === SORTING_GROUP\}/);
  });

  it("passes group and disabled through to useSortable", () => {
    const at = sortable.indexOf("useSortable({");
    const call = sortable.slice(at, sortable.indexOf("});", at));
    expect(call).toMatch(/\bgroup\b/);
    expect(call).toMatch(/\bdisabled\b/);
  });
});

// Renders the real list page and SortableItem with react-dom/server (node, no DOM). The
// page's data hooks are stubbed to hand it a list; DragDropProvider records the elements
// it is given, useSortable records what each row registers, and useListDragDrop records
// the groups it gets. Everything around the item list renders nothing.
const S = vi.hoisted(() => ({
  listType: "grocery",
  locale: "he",
  t: (key: string) => key,
  items: [] as ItemData[],
  categories: [] as ListCategory[],
  providerChildren: null as unknown,
  sortables: [] as Record<string, unknown>[],
  dragGroups: undefined as CategoryGroup[] | null | undefined,
}));

vi.mock("next-intl", () => ({ useTranslations: () => S.t, useLocale: () => S.locale }));
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
    loading: false, error: null, isShared: false, listType: S.listType, setListType: () => {},
    listIcon: null, listColor: null, categories: S.categories, setCategories: () => {},
    fetchItems: () => {}, refreshItems: () => {},
  }),
}));
vi.mock("@/src/hooks/useMutationQueue", () => ({ useMutationQueue: () => ({ addMutation: () => {}, flushQueue: () => {} }) }));
vi.mock("@/src/hooks/useItemHandlers", () => ({ useItemHandlers: () => new Proxy({}, { get: () => () => {} }) }));
vi.mock("@/src/hooks/useListRealtime", () => ({ useListRealtime: () => ({ resubscribe: () => {} }) }));
vi.mock("@/src/hooks/useListDragDrop", () => ({
  useListDragDrop: ({ groups }: { groups: CategoryGroup[] | null }) => {
    S.dragGroups = groups;
    return { handleDragStart: () => {}, handleDragEnd: () => {}, isDraggingRef: { current: false } };
  },
}));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children }: { children: unknown }) => {
    S.providerChildren = children;
    return children;
  },
}));
vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: (input: Record<string, unknown>) => {
    S.sortables.push(input);
    return { ref: () => {}, isDragSource: false };
  },
}));
vi.mock("@/components/ItemRow", () => ({ default: () => null }));
vi.mock("@/components/AddItemInput", () => ({ default: () => null }));
vi.mock("@/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/components/ShareDialog", () => ({ default: () => null }));
vi.mock("@/components/ReminderSheet", () => ({ default: () => null }));
vi.mock("@/components/list/ListHeader", () => ({ default: () => null }));
vi.mock("@/components/list/SignalSheet", () => ({ default: () => null }));
vi.mock("@/components/list/SkippedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/RecurringItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/CompletedItemsSection", () => ({ default: () => null }));
vi.mock("@/components/list/ToastContainer", () => ({ default: () => null }));

import ListPage from "@/app/list/[id]/page";

const category = (id: string, position: number, en: string, he: string): ListCategory => ({
  id, list_id: "L", name_en: en, name_he: he, name_ru: en, position, created_by: null,
});

const item = (id: string, position: number, category_id: string | null): ItemData => ({
  id, text: id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
  ordered_at: null, category_id, category_locked: false, recurring: false, position,
  created_by: null, creator_name: null, edited_by: null, editor_name: null,
});

function renderList(listType: string) {
  Object.assign(S, { listType, providerChildren: null, sortables: [], dragGroups: undefined });
  renderToStaticMarkup(createElement(ListPage));
  return {
    // The drag area's direct children, top to bottom: "# label" for a header, the id for a row.
    layout: Children.toArray(S.providerChildren as ReactNode).map((child) => {
      const el = child as ReactElement<{ id?: string; children?: unknown }>;
      return typeof el.type === "string" ? `# ${String(el.props.children)}` : el.props.id;
    }),
    sortables: S.sortables.map(({ id, index, group, disabled }) => ({ id, index, group, disabled })),
    dragGroups: S.dragGroups,
  };
}

describe("the rendered list page", () => {
  beforeEach(() => {
    S.locale = "he";
    // Top to bottom by position: milk (not sorted yet), apples, cheese, bananas.
    // Walk order: Produce, then Dairy.
    S.categories = [category("dairy", 1, "Dairy", "חלב"), category("produce", 0, "Produce", "ירקות")];
    S.items = [item("milk", 4, null), item("apples", 3, "produce"), item("cheese", 2, "dairy"), item("bananas", 1, "produce")];
  });

  it("shows a grocery list's items under category headers in walk order, in the viewer's language", () => {
    // Headers and rows are siblings: during a drag dnd-kit moves the row's DOM node into the
    // other category, so a wrapper per group would leave React removing it from the wrong parent.
    expect(renderList("grocery").layout).toEqual([
      "# categories.sorting", "milk",
      "# ירקות", "apples", "bananas",
      "# חלב", "cheese",
    ]);
  });

  it("registers each row with its group and in-group index, and rows still sorting cannot be dragged", () => {
    expect(renderList("grocery").sortables).toEqual([
      { id: "milk", index: 0, group: "sorting", disabled: true },
      { id: "apples", index: 0, group: "produce", disabled: false },
      { id: "bananas", index: 1, group: "produce", disabled: false },
      { id: "cheese", index: 0, group: "dairy", disabled: false },
    ]);
  });

  it("hands the drag hook the groups it shows", () => {
    const { dragGroups } = renderList("grocery");
    expect(dragGroups?.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["sorting", ["milk"]],
      ["produce", ["apples", "bananas"]],
      ["dairy", ["cheese"]],
    ]);
  });

  it("keeps a regular list flat, ungrouped and ordered by position", () => {
    const { layout, sortables, dragGroups } = renderList("regular");
    expect(layout).toEqual(["milk", "apples", "cheese", "bananas"]);
    expect(sortables).toEqual([
      { id: "milk", index: 0, group: undefined, disabled: undefined },
      { id: "apples", index: 1, group: undefined, disabled: undefined },
      { id: "cheese", index: 2, group: undefined, disabled: undefined },
      { id: "bananas", index: 3, group: undefined, disabled: undefined },
    ]);
    expect(dragGroups).toBeNull();
  });
});
