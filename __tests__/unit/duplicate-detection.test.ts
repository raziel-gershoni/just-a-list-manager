import { describe, it, expect } from "vitest";
import { computeDuplicateTexts, sortForDedup } from "@/src/utils/duplicate-detection";

type Row = { text: string; deleted_at: string | null };

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
});

describe("sortForDedup", () => {
  type R = { id: string; text: string; position: number };

  it("prefers a clean text over one with a curly quote — production case", () => {
    const items: R[] = [
      { id: "curly", text: "קערות חד”פ", position: 703 }, // U+201D
      { id: "gershayim", text: "קערות חד״פ", position: 702 }, // U+05F4
    ];
    expect(sortForDedup(items)[0].id).toBe("gershayim");
  });

  it("prefers a clean text over one prefixed with a bidi mark", () => {
    const items: R[] = [
      { id: "rlm", text: "‏בצל", position: 999 }, // U+200F prefix, highest position
      { id: "plain", text: "בצל", position: 1 },
    ];
    expect(sortForDedup(items)[0].id).toBe("plain");
  });

  it("falls back to highest position when both are clean", () => {
    const items: R[] = [
      { id: "a", text: "חלב", position: 100 },
      { id: "b", text: "חלב", position: 200 },
    ];
    expect(sortForDedup(items)[0].id).toBe("b");
  });

  it("falls back to highest position when both are noisy", () => {
    const items: R[] = [
      { id: "a", text: "חד”פ", position: 100 },
      { id: "b", text: "חד”פ", position: 200 },
    ];
    expect(sortForDedup(items)[0].id).toBe("b");
  });

  it("does not mutate the input array", () => {
    const items: R[] = [
      { id: "a", text: "חלב", position: 100 },
      { id: "b", text: "חלב", position: 200 },
    ];
    const before = [...items];
    sortForDedup(items);
    expect(items).toEqual(before);
  });
});
