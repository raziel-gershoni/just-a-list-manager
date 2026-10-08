import { describe, it, expect } from "vitest";
import { groupByCategory, SORTING_GROUP } from "@/src/utils/list-helpers";
import type { ItemData, ListCategory } from "@/src/types";

const item = (id: string, category_id: string | null | undefined, position: number): ItemData => ({
  id, text: id, completed: false, completed_at: null, deleted_at: null, skipped_at: null, ordered_at: null,
  recurring: false, position, created_by: null, creator_name: null, edited_by: null, editor_name: null, category_id,
});
const cat = (id: string, position: number, en: string, he = en): ListCategory => ({
  id, list_id: "L", name_en: en, name_he: he, name_ru: en, position, created_by: null,
});

describe("groupByCategory", () => {
  const cats = [cat("dairy", 1, "Dairy", "חלב"), cat("produce", 0, "Produce", "ירקות"), cat("frozen", 2, "Frozen")];

  it("puts uncategorized items first under the sorting label, then categories in walk order, skipping empty ones", () => {
    const active = [item("a", "dairy", 9), item("b", null, 8), item("c", "produce", 7), item("d", undefined, 6), item("e", "dairy", 5)];
    const groups = groupByCategory(active, cats, "he", "ממיין…");
    expect(groups.map((g) => [g.key, g.categoryId, g.label, g.items.map((i) => i.id)])).toEqual([
      [SORTING_GROUP, null, "ממיין…", ["b", "d"]],
      ["produce", "produce", "ירקות", ["c"]],
      ["dairy", "dairy", "חלב", ["a", "e"]],
    ]);
  });

  it("treats an item whose category no longer exists as still sorting", () => {
    const groups = groupByCategory([item("a", "gone", 1)], cats, "en", "Sorting…");
    expect(groups.map((g) => g.key)).toEqual([SORTING_GROUP]);
  });

  it("returns no groups for no items", () => {
    expect(groupByCategory([], cats, "en", "Sorting…")).toEqual([]);
  });
});
