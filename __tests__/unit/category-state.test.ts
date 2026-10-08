import { describe, it, expect } from "vitest";
import { applyCategoryChange, restoreCategory, restoreCategoryName, restorePositions, sortCategories } from "@/src/utils/category-state";
import type { ListCategory } from "@/src/types";

const cat = (id: string, position: number, name = id): ListCategory => ({
  id, list_id: "L", name_en: name, name_he: name, name_ru: name, position, created_by: null,
});

describe("applyCategoryChange", () => {
  it("adds an inserted category in walk order, once", () => {
    const start = [cat("a", 0), cat("c", 2)];
    const change = { table: "list_categories" as const, eventType: "INSERT" as const, new: cat("b", 1) as unknown as Record<string, unknown>, old: {} };
    const once = applyCategoryChange(start, change);
    expect(once.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(applyCategoryChange(once, change).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("applies a rename or reorder", () => {
    const next = applyCategoryChange([cat("a", 0), cat("b", 1)], {
      table: "list_categories", eventType: "UPDATE", new: cat("a", 5, "Fruit") as unknown as Record<string, unknown>, old: {},
    });
    expect(next.map((c) => [c.id, c.name_en])).toEqual([["b", "b"], ["a", "Fruit"]]);
  });

  it("removes a deleted category", () => {
    const next = applyCategoryChange([cat("a", 0), cat("b", 1)], {
      table: "list_categories", eventType: "DELETE", new: {}, old: { id: "a" },
    });
    expect(next.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("sortCategories", () => {
  it("orders by position", () => {
    expect(sortCategories([cat("b", 1), cat("a", 0)]).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

// Undoing a failed sheet change must touch only that change: Realtime rows that
// arrived while the request was in flight (an AI rescan, a collaborator) stay.
describe("undoing a failed sheet change", () => {
  it("restoreCategoryName puts back only the name the sheet changed", () => {
    const original = cat("a", 0, "Fruit");
    const renamed = { ...original, name_he: "Pet" };
    const next = restoreCategoryName([renamed, cat("ai", 1)], original, "he");
    expect(next.map((c) => [c.id, c.name_he])).toEqual([["a", "Fruit"], ["ai", "ai"]]);
  });

  it("restoreCategoryName keeps a newer position from Realtime", () => {
    const original = cat("a", 0, "Fruit");
    const next = restoreCategoryName([{ ...original, name_en: "Pet", position: 3 }], original, "en");
    expect(next).toEqual([{ ...original, position: 3 }]);
  });

  it("restoreCategory puts a deleted category back in walk order, once", () => {
    const original = cat("b", 1);
    const once = restoreCategory([cat("a", 0), cat("ai", 2)], original);
    expect(once.map((c) => c.id)).toEqual(["a", "b", "ai"]);
    expect(restoreCategory(once, original).map((c) => c.id)).toEqual(["a", "b", "ai"]);
  });

  it("restorePositions puts back the earlier order and keeps new categories", () => {
    const before = [cat("a", 0), cat("b", 1)];
    const moved = [cat("b", 0), cat("a", 1), cat("ai", 2)];
    expect(restorePositions(moved, before).map((c) => [c.id, c.position])).toEqual([["a", 0], ["b", 1], ["ai", 2]]);
  });
});
