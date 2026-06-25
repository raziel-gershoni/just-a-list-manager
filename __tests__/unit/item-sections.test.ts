import { describe, it, expect } from "vitest";
import { isActiveItem, isSkippedItem } from "@/src/utils/list-helpers";
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
  it("an ordered item stays active (shown in the list, not a separate section)", () => {
    const i = makeItem({ ordered_at: "2026-06-26T00:00:00Z" });
    expect(isActiveItem(i)).toBe(true);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("a skipped item is skipped, not active", () => {
    const i = makeItem({ skipped_at: "2026-06-26T00:00:00Z" });
    expect(isSkippedItem(i)).toBe(true);
    expect(isActiveItem(i)).toBe(false);
  });

  it("a plain item is active", () => {
    const i = makeItem();
    expect(isActiveItem(i)).toBe(true);
    expect(isSkippedItem(i)).toBe(false);
  });

  it("completed/deleted items are neither active nor skipped", () => {
    expect(isActiveItem(makeItem({ completed: true }))).toBe(false);
    expect(isActiveItem(makeItem({ deleted_at: "x" }))).toBe(false);
    expect(isSkippedItem(makeItem({ skipped_at: "x", completed: true }))).toBe(false);
  });
});
