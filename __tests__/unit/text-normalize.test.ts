import { describe, it, expect } from "vitest";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

describe("normalizeForCompare", () => {
  it("is case-insensitive for Latin text", () => {
    expect(normalizeForCompare("Milk")).toBe(normalizeForCompare("milk"));
  });

  it("does NOT treat genuinely different items as equal (no typo tolerance by design)", () => {
    expect(normalizeForCompare("חלב")).not.toBe(normalizeForCompare("חלבב"));
  });
});

describe("normalizeForStorage", () => {
  it("folds curly U+201D and Hebrew gershayim U+05F4 both to ASCII straight quote", () => {
    const curly = 'קערות חד"פ';
    const gershayim = 'קערות חד״פ';
    const expected = 'קערות חד"פ';
    expect(normalizeForStorage(curly)).toBe(expected);
    expect(normalizeForStorage(gershayim)).toBe(expected);
  });

  it("strips a leading RLM mark (U+200F)", () => {
    expect(normalizeForStorage("‏בצל מיובש")).toBe("בצל מיובש");
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(normalizeForStorage("  קמח   לחם  ")).toBe("קמח לחם");
  });

  it("preserves case (key difference from normalizeForCompare)", () => {
    expect(normalizeForStorage("Milk")).toBe("Milk");
  });

  it("folds Latin smart apostrophe (U+2019) to ASCII", () => {
    expect(normalizeForStorage("O’Brien")).toBe("O'Brien");
  });

  it("leaves genuinely different texts different (no typo tolerance)", () => {
    expect(normalizeForStorage("חלב")).not.toBe(normalizeForStorage("חלבב"));
  });
});
