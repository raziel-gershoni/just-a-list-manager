import { describe, it, expect } from "vitest";
import { normalizeForCompare, normalizeForStorage } from "@/src/utils/text-normalize";

describe("normalizeForCompare", () => {
  it("treats curly double quote (U+201D) and Hebrew gershayim (U+05F4) as equal — production case", () => {
    const curly = 'קערות חד”פ';
    const gershayim = 'קערות חד״פ';
    expect(normalizeForCompare(curly)).toBe(normalizeForCompare(gershayim));
    expect(normalizeForCompare(curly)).not.toBe(""); // both should produce a non-empty key
  });

  it("strips a leading RLM mark (U+200F) so prefixed and unprefixed items compare equal", () => {
    expect(normalizeForCompare("‏בצל מיובש")).toBe(normalizeForCompare("בצל מיובש"));
  });

  it("collapses runs of whitespace and trims edges", () => {
    expect(normalizeForCompare("  קמח   לחם  ")).toBe(normalizeForCompare("קמח לחם"));
  });

  it("does NOT collapse a comma into whitespace", () => {
    expect(normalizeForCompare("שלום, world")).not.toBe(normalizeForCompare("שלום world"));
  });

  it("is case-insensitive for Latin text", () => {
    expect(normalizeForCompare("Milk")).toBe(normalizeForCompare("milk"));
  });

  it("treats Latin straight apostrophe and curly apostrophe as equal", () => {
    expect(normalizeForCompare("O’Brien")).toBe(normalizeForCompare("O’Brien"));
  });

  it("does NOT treat genuinely different items as equal (no typo tolerance by design)", () => {
    expect(normalizeForCompare("חלב")).not.toBe(normalizeForCompare("חלבב"));
  });

  it("does NOT fold Hebrew final letters into their medial form", () => {
    // mem sofit (ם U+05DD) is semantically distinct from medial mem (מ U+05DE)
    expect(normalizeForCompare("שלום")).not.toBe(normalizeForCompare("שלומ"));
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
