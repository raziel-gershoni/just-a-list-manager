import { describe, it, expect } from "vitest";
import { computeUnmarkCompleted } from "@/src/utils/unmark-completed";
import type { ItemData } from "@/src/types";

// Full-shape ItemData factory so the fixtures stay valid if the interface grows.
function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: "x",
    completed: false,
    completed_at: null,
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    position: 0,
    created_by: null,
    creator_name: null,
    edited_by: null,
    editor_name: null,
    ...over,
  };
}

describe("computeUnmarkCompleted", () => {
  it("flips only completed, non-deleted items", () => {
    const items = [
      item({ id: "a", completed: true, completed_at: "2026-07-01T00:00:00Z" }),
      item({ id: "b", completed: false }),
      item({
        id: "c",
        completed: true,
        completed_at: "2026-07-02T00:00:00Z",
        deleted_at: "2026-07-03T00:00:00Z",
      }),
    ];
    const { next, affectedIds } = computeUnmarkCompleted(items);

    expect(affectedIds).toEqual(["a"]);
    expect(next[0]).toMatchObject({ id: "a", completed: false, completed_at: null });
    expect(next[1]).toBe(items[1]); // untouched active item returned by reference
    expect(next[2]).toBe(items[2]); // deleted-but-completed item left alone
  });

  it("returns empty affectedIds when nothing is completed", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    const { next, affectedIds } = computeUnmarkCompleted(items);
    expect(affectedIds).toEqual([]);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(items[0]);
  });

  it("preserves order of affectedIds", () => {
    const items = [
      item({ id: "x", completed: true }),
      item({ id: "y", completed: false }),
      item({ id: "z", completed: true }),
    ];
    expect(computeUnmarkCompleted(items).affectedIds).toEqual(["x", "z"]);
  });

  it("does not mutate the input array or its completed items", () => {
    const original = item({ id: "a", completed: true, completed_at: "2026-07-01T00:00:00Z" });
    const items = [original];
    computeUnmarkCompleted(items);
    expect(original.completed).toBe(true);
    expect(original.completed_at).toBe("2026-07-01T00:00:00Z");
  });
});
