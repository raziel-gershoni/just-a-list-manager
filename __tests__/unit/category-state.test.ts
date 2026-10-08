import { describe, it, expect } from "vitest";
import { applyCategoryChange, sortCategories } from "@/src/utils/category-state";
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
