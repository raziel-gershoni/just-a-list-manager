import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("category realtime wiring", () => {
  it("subscribes to list_categories for this list", () => {
    const src = read("src/hooks/useRealtimeList.ts");
    const at = src.indexOf('table: "list_categories"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 120)).toContain("filter: `list_id=eq.${listId}`");
  });

  it("feeds list_categories changes into setCategories through applyCategoryChange", () => {
    const src = read("src/hooks/useListRealtime.ts");
    const at = src.indexOf('change.table === "list_categories"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/setCategories\(\(prev\) => applyCategoryChange\(prev, change\)\)/);
  });

  // Loading categories with the items (first fetch and refresh) is run for real in
  // list-data-categories.test.ts.

  it("the page hands setCategories to useListRealtime", () => {
    const page = read("app/list/[id]/page.tsx");
    const at = page.indexOf("useListRealtime({");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at, page.indexOf("})", at))).toContain("setCategories");
  });
});
