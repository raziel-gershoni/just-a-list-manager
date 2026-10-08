import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const page = readFileSync(resolve(process.cwd(), "app/list/[id]/page.tsx"), "utf8");
const sheet = readFileSync(resolve(process.cwd(), "components/list/CategoriesSheet.tsx"), "utf8");

describe("categories sheet wiring", () => {
  it("the settings sheet offers Categories on grocery lists only", () => {
    // The gate must wrap the button itself, not merely appear near it.
    expect(page).toMatch(
      /\{listType === "grocery" && \(\s*<button\s+onClick=\{\(\) => \{[^}]*setShowCategories\(true\);?[^}]*\}\}[^<]*>\s*\{t\('categories\.manage'\)\}\s*<\/button>\s*\)\}/
    );
  });

  it("the page renders the sheet with the list's categories", () => {
    const at = page.indexOf("<CategoriesSheet");
    expect(at).toBeGreaterThan(-1);
    const el = page.slice(at, page.indexOf("/>", at));
    for (const prop of ["categories={categories}", "setCategories={setCategories}", "listId={listId}", "counts={categoryCounts}"]) expect(el).toContain(prop);
  });

  it("counts each category's items to buy from the active items", () => {
    expect(page).toMatch(/const categoryCounts = useMemo\(\(\) => countByCategory\(activeItems\), \[activeItems\]\);/);
  });

  it("the sheet calls every category endpoint helper", () => {
    for (const fn of ["createCategory(", "renameCategory(", "deleteCategory(", "reorderCategories("]) expect(sheet).toContain(fn);
  });

  it("the sheet shows its own error, because it covers the page's toasts", () => {
    // ToastContainer draws at z-30, under the sheet's z-50 overlay, so a toast would go unseen.
    expect(sheet).toMatch(/runCategoryAction\(jwtRef\.current, action, \(\) => \{\s*undo\?\.\(\);\s*setError\(t\("categories\.error"\)\);\s*\}\)/);
    expect(sheet).toMatch(/\{error && \(\s*<p ref=\{errorRef\} role="alert"[^>]*>\{error\}<\/p>\s*\)\}/);
  });

  it("a failed change undoes only itself, and a failed add only reports", () => {
    expect(sheet).toMatch(/run\(async \(jwt\) => \{\s*const created = await createCategory\([^;]*;\s*setCategories\([^;]*;\s*\}\);/);
    expect(sheet).toMatch(/renameCategory\([^;]*;\s*setCategories\([^;]*;\s*\}, \(\) => setCategories\(\(prev\) => restoreCategoryName\(prev, original, locale\)\)\);/);
    expect(sheet).toMatch(/run\(\(jwt\) => deleteCategory\(listId, jwt, original\.id\), \(\) => setCategories\(\(prev\) => restoreCategory\(prev, original\)\)\);/);
    expect(sheet).toMatch(/run\(\(jwt\) => reorderCategories\(listId, jwt, next\.map\(\(c\) => c\.id\)\), \(\) => setCategories\(\(prev\) => restorePositions\(prev, ordered\)\)\);/);
  });

  it("deleting a category asks first, with the app's native confirm", () => {
    // A blur-reset inline "Delete?" never resets on iOS WebKit, where tapping a button does not focus it.
    expect(sheet).toMatch(/onDelete=\{\(\) => askConfirm\(t\("categories\.confirmDelete", \{ name: categoryLabel\(c, locale\) \}\), \(\) => remove\(c\)\)\}/);
    expect(sheet).toMatch(/<button onClick=\{onDelete\}/);
  });
});
