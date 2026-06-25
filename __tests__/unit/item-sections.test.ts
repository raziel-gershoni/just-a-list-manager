import { describe, it, expect } from "vitest";
import { isActiveItem, isSkippedItem, isOrderedItem } from "@/src/utils/list-helpers";
import type { ItemData } from "@/src/types";

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
  return {
    id: "x", text: "t", completed: false, completed_at: null,
    deleted_at: null, skipped_at: null, ordered_at: null, recurring: false,
    position: 1, created_by: null, creator_name: null, edited_by: null, editor_name: null,
    ...overrides,
  };
}

describe("item section predicates", () => {
  it("ordered item is ordered, not active, not skipped", () => {
    const i = makeItem({ ordered_at: "2026-06-26T00:00:00Z" });
    expect(isOrderedItem(i)).toBe(true);
    expect(isActiveItem(i)).toBe(false);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("ordered takes precedence over a stray skipped_at", () => {
    const i = makeItem({ ordered_at: "2026-06-26T00:00:00Z", skipped_at: "2026-06-26T00:00:00Z" });
    expect(isOrderedItem(i)).toBe(true);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("plain item is active only", () => {
    const i = makeItem();
    expect(isActiveItem(i)).toBe(true);
    expect(isOrderedItem(i)).toBe(false);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("completed/deleted ordered item is not in the ordered group", () => {
    expect(isOrderedItem(makeItem({ ordered_at: "x", completed: true }))).toBe(false);
    expect(isOrderedItem(makeItem({ ordered_at: "x", deleted_at: "x" }))).toBe(false);
  });
});
