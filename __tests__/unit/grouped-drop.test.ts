import { describe, it, expect } from "vitest";
import { computeGroupedDrop } from "@/src/utils/grouped-drop";
import type { CategoryGroup, ItemData } from "@/src/types";

const it_ = (id: string) => ({ id } as ItemData);
const groups: CategoryGroup[] = [
  { key: "sorting", categoryId: null, label: "Sorting…", items: [it_("s1")] },
  { key: "produce", categoryId: "produce", label: "Produce", items: [it_("a"), it_("b")] },
  { key: "dairy", categoryId: "dairy", label: "Dairy", items: [it_("c"), it_("d")] },
];

describe("computeGroupedDrop", () => {
  it("reorders inside a category without moving it", () => {
    expect(computeGroupedDrop(groups, "b", "produce", 0)).toEqual({ orderedIds: ["s1", "b", "a", "c", "d"], moveTo: null });
  });

  it("moves an item into another category at the dropped index", () => {
    expect(computeGroupedDrop(groups, "a", "dairy", 1)).toEqual({ orderedIds: ["s1", "b", "c", "a", "d"], moveTo: "dairy" });
  });

  it("clamps an index past the end of the target group", () => {
    expect(computeGroupedDrop(groups, "a", "dairy", 9)).toEqual({ orderedIds: ["s1", "b", "c", "d", "a"], moveTo: "dairy" });
  });

  it("clamps a negative index to the start of the target group", () => {
    expect(computeGroupedDrop(groups, "a", "dairy", -1)).toEqual({ orderedIds: ["s1", "b", "a", "c", "d"], moveTo: "dairy" });
  });

  it("ignores a drop into the sorting group, a drop on itself, and unknown groups or items", () => {
    expect(computeGroupedDrop(groups, "a", "sorting", 0)).toBeNull();
    expect(computeGroupedDrop(groups, "a", "produce", 0)).toBeNull();
    expect(computeGroupedDrop(groups, "a", "nope", 0)).toBeNull();
    expect(computeGroupedDrop(groups, "zz", "dairy", 0)).toBeNull();
    expect(computeGroupedDrop(groups, "a", undefined, 0)).toBeNull();
    expect(computeGroupedDrop(groups, "a", "dairy", undefined)).toBeNull();
  });
});
