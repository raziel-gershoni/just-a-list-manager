import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const page = readFileSync(resolve(process.cwd(), "app/list/[id]/page.tsx"), "utf8");
const sheet = readFileSync(resolve(process.cwd(), "components/list/CategoriesSheet.tsx"), "utf8");

describe("categories sheet wiring", () => {
  it("the settings sheet offers Categories on grocery lists only", () => {
    const at = page.indexOf("t('categories.manage')");
    expect(at).toBeGreaterThan(-1);
    const before = page.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/listType === "grocery" &&/);
    expect(before).toMatch(/setShowCategories\(true\)/);
  });

  it("the page renders the sheet with the list's categories", () => {
    const at = page.indexOf("<CategoriesSheet");
    expect(at).toBeGreaterThan(-1);
    const el = page.slice(at, page.indexOf("/>", at));
    for (const prop of ["categories={categories}", "setCategories={setCategories}", "listId={listId}"]) expect(el).toContain(prop);
  });

  it("the sheet calls every category endpoint helper", () => {
    for (const fn of ["createCategory(", "renameCategory(", "deleteCategory(", "reorderCategories("]) expect(sheet).toContain(fn);
  });
});
