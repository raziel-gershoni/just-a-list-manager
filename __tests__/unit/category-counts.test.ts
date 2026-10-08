import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countByCategory } from "@/src/utils/list-helpers";
import type { ItemData, ListCategory } from "@/src/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${JSON.stringify(values)})` : key,
  useLocale: () => "en",
}));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: () => ({ ref: () => {}, handleRef: () => {}, isDragSource: false }),
}));

import CategoriesSheet from "@/components/list/CategoriesSheet";

const item = (id: string, category_id: string | null, over: Partial<ItemData> = {}): ItemData => ({
  id, text: id, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
  recurring: false, position: 1, created_by: null, creator_name: null, edited_by: null, editor_name: null,
  category_id, ...over,
});
const category = (id: string, position: number, name: string): ListCategory => ({
  id, list_id: "L", name_en: name, name_he: name, name_ru: name, position, created_by: null,
});

describe("countByCategory", () => {
  it("counts the items still to buy in each category, as the grouped list shows them", () => {
    const counts = countByCategory([
      item("milk", "dairy"),
      item("cheese", "dairy"),
      item("apples", "produce"),
      item("bread", null),
      item("yogurt", "dairy", { completed: true, completed_at: "2026-10-09T08:00:00Z" }),
      item("cream", "dairy", { skipped_at: "2026-10-09T08:00:00Z" }),
      item("butter", "dairy", { deleted_at: "2026-10-09T08:00:00Z" }),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ dairy: 2, produce: 1 });
  });
});

describe("CategoriesSheet counts", () => {
  it("shows each category's count, 0 for an empty one, labelled for screen readers", () => {
    const html = renderToStaticMarkup(
      createElement(CategoriesSheet, {
        listId: "L",
        jwtRef: { current: "jwt" },
        categories: [category("produce", 0, "Produce"), category("dairy", 1, "Dairy"), category("party", 2, "Party")],
        counts: new Map([["produce", 1], ["dairy", 2]]),
        setCategories: () => {},
        onClose: () => {},
      })
    );
    // The digit is for the eye; screen readers get the full sentence instead.
    const shown = [...html.matchAll(/<span aria-hidden="true">(\d+)<\/span><span class="sr-only">categories\.itemCount\(\{&quot;count&quot;:(\d+)\}\)<\/span>/g)]
      .map((m) => [Number(m[1]), Number(m[2])]);
    expect(shown).toEqual([[1, 1], [2, 2], [0, 0]]);
    // In walk order, next to its own name.
    expect(html.indexOf("Produce")).toBeLessThan(html.indexOf("&quot;count&quot;:1"));
    expect(html.indexOf("&quot;count&quot;:1")).toBeLessThan(html.indexOf("Dairy"));
  });

  const render = (categories: ListCategory[]) =>
    renderToStaticMarkup(
      createElement(CategoriesSheet, {
        listId: "L", jwtRef: { current: "jwt" }, categories, counts: new Map(),
        setCategories: () => {}, onClose: () => {},
      })
    );

  it("shows how many categories the list has, out of the 20 allowed, next to the title", () => {
    const html = render([category("produce", 0, "Produce"), category("dairy", 1, "Dairy"), category("party", 2, "Party")]);
    const title = html.indexOf("categories.title");
    const total = html.indexOf("categories.total({&quot;count&quot;:3,&quot;max&quot;:20})");
    expect(title).toBeGreaterThan(-1);
    expect(total).toBeGreaterThan(title);
    expect(total).toBeLessThan(html.indexOf("Produce"));
  });

  it("shows no total before the first sort, when the empty message says it all", () => {
    expect(render([])).not.toContain("categories.total");
  });
});
