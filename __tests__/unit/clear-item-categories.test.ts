import { describe, it, expect } from "vitest";
import { clearItemCategories } from "@/src/utils/category-state";
import type { ItemData } from "@/src/types";

const item = (over: Partial<ItemData>): ItemData => ({ id: "x", text: "flour", completed: false, position: 1, ...over } as ItemData);

describe("clearItemCategories", () => {
  it("takes every item out of its category and unlocks hand placements", () => {
    const out = clearItemCategories([
      item({ id: "a", category_id: "c1", category_locked: false }),
      item({ id: "b", category_id: "c2", category_locked: true }),
      item({ id: "c", category_id: null, category_locked: true }),
      item({ id: "d", category_id: null, category_locked: false }),
    ]);
    expect(out.map((i) => [i.id, i.category_id, i.category_locked])).toEqual([
      ["a", null, false], ["b", null, false], ["c", null, false], ["d", null, false],
    ]);
  });

  it("keeps untouched rows as they are, and the same array when nothing had a category", () => {
    const plain = item({ id: "d", category_id: null, category_locked: false });
    const placed = item({ id: "a", category_id: "c1" });
    const out = clearItemCategories([plain, placed]);
    expect(out[0]).toBe(plain);
    const none = [plain];
    expect(clearItemCategories(none)).toBe(none);
  });
});
