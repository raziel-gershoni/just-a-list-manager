import { describe, it, expect } from "vitest";
import { computeDuplicateTexts } from "@/src/utils/duplicate-detection";

type Row = { text: string; deleted_at: string | null };

describe("computeDuplicateTexts", () => {
  it("flags glyph-equal items that differ only in punctuation codepoint (production case)", () => {
    const items: Row[] = [
      { text: "קערות חד”פ", deleted_at: null }, // U+201D
      { text: "קערות חד״פ", deleted_at: null }, // U+05F4
    ];
    const dupes = computeDuplicateTexts(items);
    // Both items, when keyed for lookup, must hit the Set.
    expect(dupes.size).toBe(1);
  });

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
});
