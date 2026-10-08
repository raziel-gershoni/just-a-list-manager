import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { IntlMessageFormat } from "intl-messageformat";

// The Categories sheet's counts, formatted the way next-intl formats them.
function format(locale: string, key: "itemCount" | "total", values: Record<string, number>): string {
  const messages = JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}.json`), "utf8"));
  return String(new IntlMessageFormat(messages.categories[key], locale).format(values));
}

describe("categories.itemCount", () => {
  it.each([
    ["en", 1, "1 item to buy"],
    ["en", 3, "3 items to buy"],
    ["he", 1, "פריט אחד לקנייה"],
    ["he", 3, "3 פריטים לקנייה"],
    ["ru", 1, "1 товар к покупке"],
    ["ru", 3, "3 товара к покупке"],
    ["ru", 5, "5 товаров к покупке"],
    ["ru", 21, "21 товар к покупке"],
  ])("%s with %i reads %s", (locale, count, expected) => {
    expect(format(locale, "itemCount", { count })).toBe(expected);
  });
});

describe("categories.total", () => {
  it.each([
    ["en", "7 of 20"],
    ["he", "7 מתוך 20"],
    ["ru", "7 из 20"],
  ])("%s reads %s", (locale, expected) => {
    expect(format(locale, "total", { count: 7, max: 20 })).toBe(expected);
  });
});
