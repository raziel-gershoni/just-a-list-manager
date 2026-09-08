import { describe, it, expect } from "vitest";
import { isActiveItem, isSkippedItem, isParkedRecurringItem } from "@/src/utils/list-helpers";
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

describe("isParkedRecurringItem", () => {
  it("parks a completed recurring item", () => {
    const i = makeItem({ recurring: true, completed: true, completed_at: "2026-09-08T00:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(true);
  });

  it("does not park a deleted recurring item — deleting is final", () => {
    const i = makeItem({
      recurring: true,
      completed: true,
      completed_at: "2026-09-08T00:00:00Z",
      deleted_at: "2026-09-08T01:00:00Z",
    });
    expect(isParkedRecurringItem(i)).toBe(false);
  });

  it("does not park a deleted recurring item that was never completed", () => {
    const i = makeItem({ recurring: true, deleted_at: "2026-09-08T01:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(false);
  });

  it("does not park an active recurring item", () => {
    const i = makeItem({ recurring: true });
    expect(isParkedRecurringItem(i)).toBe(false);
    expect(isActiveItem(i)).toBe(true);
  });

  it("does not park a completed non-recurring item", () => {
    const i = makeItem({ completed: true, completed_at: "2026-09-08T00:00:00Z" });
    expect(isParkedRecurringItem(i)).toBe(false);
  });
});
