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

  it("loads categories with the items, in both the first fetch and the refresh", () => {
    const src = read("src/hooks/useListData.ts");
    expect(src.match(/\/categories`/g)?.length).toBe(2);
    expect(src.match(/setCategories\(sortCategories\(/g)?.length).toBe(2);
  });

  it("fetches categories only for grocery lists", () => {
    const src = read("src/hooks/useListData.ts");
    const fetches = [...src.matchAll(/\/categories`/g)];
    expect(fetches.length).toBe(2);
    for (const m of fetches) {
      expect(src.slice(m.index - 120, m.index)).toMatch(/if \(\w+ === "grocery"\) \{/);
    }
  });

  it("the page hands setCategories to useListRealtime", () => {
    const page = read("app/list/[id]/page.tsx");
    const at = page.indexOf("useListRealtime({");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at, page.indexOf("})", at))).toContain("setCategories");
  });
});
