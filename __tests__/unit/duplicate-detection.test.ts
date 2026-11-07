import { describe, it, expect } from "vitest";
import { computeDuplicateTexts } from "@/src/utils/duplicate-detection";

type Row = { text: string; deleted_at: string | null; completed?: boolean; recurring?: boolean };

describe("computeDuplicateTexts", () => {
  it("does not flag a unique item", () => {
    const items: Row[] = [{ text: "חלב", deleted_at: null }];
    expect(computeDuplicateTexts(items).size).toBe(0);
  });

  it("does not flag soft-deleted items", () => {
    const items: Row[] = [
      { text: "חלב", deleted_at: null },
      { text: "חלב", deleted_at: "2026-01-01T00:00:00Z" },
    ];
    expect(computeDuplicateTexts(items).size).toBe(0);
  });

  it("flags exact text duplicates (regression guard for original behavior)", () => {
    const items: Row[] = [
      { text: "חלב", deleted_at: null },
      { text: "חלב", deleted_at: null },
    ];
    expect(computeDuplicateTexts(items).size).toBe(1);
  });

  it("does not count a parked recurring staple (bought or paused) as a copy of an active item", () => {
    const items: Row[] = [
      { text: "milk", deleted_at: null, completed: true, recurring: true },
      { text: "milk", deleted_at: null },
    ];
    expect(computeDuplicateTexts(items).size).toBe(0);
  });

  it("still flags two active copies of a recurring staple", () => {
    const items: Row[] = [
      { text: "milk", deleted_at: null, completed: false, recurring: true },
      { text: "milk", deleted_at: null, completed: false, recurring: true },
    ];
    expect(computeDuplicateTexts(items).size).toBe(1);
  });

  it("still counts a completed non-recurring copy next to an active one", () => {
    const items: Row[] = [
      { text: "milk", deleted_at: null, completed: true, recurring: false },
      { text: "milk", deleted_at: null },
    ];
    expect(computeDuplicateTexts(items).size).toBe(1);
  });
});
