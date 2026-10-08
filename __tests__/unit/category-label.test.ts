import { describe, it, expect } from "vitest";
import { categoryLabel } from "@/src/types/categories";

const dairy = { name_en: "Dairy", name_he: "מוצרי חלב", name_ru: "Молочные" };

describe("categoryLabel", () => {
  it.each([
    ["en", "Dairy"],
    ["he", "מוצרי חלב"],
    ["ru", "Молочные"],
    ["fr", "Dairy"],
  ])("shows the %s name", (locale, expected) => {
    expect(categoryLabel(dairy, locale)).toBe(expected);
  });

  it("falls back to any non-empty name when the viewer's is blank", () => {
    expect(categoryLabel({ name_en: " ", name_he: "", name_ru: "Хлеб" }, "he")).toBe("Хлеб");
    expect(categoryLabel({ name_en: "Bakery", name_he: "  ", name_ru: "" }, "he")).toBe("Bakery");
  });
});
