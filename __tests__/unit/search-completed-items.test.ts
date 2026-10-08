import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";
import { searchCompletedItems, shouldSearchWhileTyping, computeSuggestions } from "@/src/utils/search-completed-items";

function item(over: Partial<ItemData> & { id: string; text: string }): ItemData {
  return {
    completed: true,
    completed_at: "2026-01-01T00:00:00+00:00",
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    position: 0,
    created_by: null,
    creator_name: null,
    edited_by: null,
    editor_name: null,
    ...over,
  };
}

const ids = (r: { id: string }[]) => r.map((x) => x.id);

describe("searchCompletedItems", () => {
  it("matches substrings case-insensitively (Latin and Cyrillic)", () => {
    const items = [item({ id: "a", text: "Whole Milk" }), item({ id: "b", text: "Молоко" })];
    expect(ids(searchCompletedItems(items, "milk"))).toEqual(["a"]);
    expect(ids(searchCompletedItems(items, "МОЛО"))).toEqual(["b"]);
  });

  it("normalizes the query like storage", () => {
    const items = [item({ id: "a", text: `Mom's "list"` })];
    expect(ids(searchCompletedItems(items, "mom’s"))).toEqual(["a"]);
    expect(ids(searchCompletedItems(items, "‏mom"))).toEqual(["a"]);
    expect(ids(searchCompletedItems(items, "”list”"))).toEqual(["a"]);
  });

  it("excludes non-completed, deleted and pending items", () => {
    const items = [
      item({ id: "open", text: "milk", completed: false }),
      item({ id: "del", text: "milk", deleted_at: "2026-01-02T00:00:00Z" }),
      item({ id: "pend", text: "milk", _pending: true }),
      item({ id: "ok", text: "milk" }),
    ];
    expect(ids(searchCompletedItems(items, "milk"))).toEqual(["ok"]);
  });

  it("includes recurring completed items", () => {
    expect(ids(searchCompletedItems([item({ id: "r", text: "eggs", recurring: true })], "eggs"))).toEqual(["r"]);
  });

  it("orders by completed_at descending, nulls last, across Z and +00:00", () => {
    const items = [
      item({ id: "null", text: "x", completed_at: null }),
      item({ id: "old", text: "x", completed_at: "2026-01-01T10:00:00+00:00" }),
      item({ id: "newZ", text: "x", completed_at: "2026-01-01T10:00:01.500Z" }),
      item({ id: "mid", text: "x", completed_at: "2026-01-01T10:00:01+00:00" }),
    ];
    expect(ids(searchCompletedItems(items, "x"))).toEqual(["newZ", "mid", "old", "null"]);
  });

  it("compares completed_at as instants, not strings (non-UTC offset)", () => {
    const items = [
      // 05:00Z: older, although "10:00" > "06:00" as text
      item({ id: "plus5", text: "x", completed_at: "2026-09-07T10:00:00+05:00" }),
      item({ id: "utc", text: "x", completed_at: "2026-09-07T06:00:00Z" }),
    ];
    expect(ids(searchCompletedItems(items, "x"))).toEqual(["utc", "plus5"]);
  });

  it("respects limit (default 10)", () => {
    const items = Array.from({ length: 15 }, (_, n) => item({ id: `i${n}`, text: "milk" }));
    expect(searchCompletedItems(items, "milk")).toHaveLength(10);
    expect(searchCompletedItems(items, "milk", 3)).toHaveLength(3);
  });

  it("returns [] for empty or whitespace query", () => {
    const items = [item({ id: "a", text: "milk" })];
    expect(searchCompletedItems(items, "")).toEqual([]);
    expect(searchCompletedItems(items, "   ")).toEqual([]);
  });

  it("matches % and _ literally", () => {
    const items = [item({ id: "pct", text: "100% juice" }), item({ id: "us", text: "a_b" }), item({ id: "no", text: "axb" })];
    expect(ids(searchCompletedItems(items, "%"))).toEqual(["pct"]);
    expect(ids(searchCompletedItems(items, "a_b"))).toEqual(["us"]);
  });
});

describe("shouldSearchWhileTyping", () => {
  it("is off for reminders only", () => {
    expect(shouldSearchWhileTyping("reminders")).toBe(false);
    expect(shouldSearchWhileTyping("regular")).toBe(true);
    expect(shouldSearchWhileTyping("grocery")).toBe(true);
  });
});

describe("computeSuggestions", () => {
  const items = [item({ id: "m", text: "Milk" }), item({ id: "e", text: "Eggs" })];

  it("is empty for reminders even when a completed item matches", () => {
    expect(computeSuggestions("reminders", items, "mil")).toEqual([]);
  });

  it("matches for regular and grocery lists", () => {
    expect(ids(computeSuggestions("regular", items, "mil"))).toEqual(["m"]);
    expect(ids(computeSuggestions("grocery", items, "mil"))).toEqual(["m"]);
  });

  it("searches only the segment after the last comma", () => {
    expect(ids(computeSuggestions("regular", items, "eggs, mil"))).toEqual(["m"]);
    expect(computeSuggestions("regular", items, "eggs, ")).toEqual([]);
  });
});

describe("source wiring", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("useListData sends every item GET (load, refresh, Sorting… retry) with the 500 limit", () => {
    const src = read("src/hooks/useListData.ts");
    expect(src).toMatch(/ITEMS_FETCH_LIMIT = 500/);
    expect(src).toContain("const ITEMS_URL_SUFFIX = `?limit=${ITEMS_FETCH_LIMIT}`;");
    const gets = src.match(/fetch\(`\/api\/lists\/\$\{listId\}\/items[^`]*`, \{\s*headers/g) ?? [];
    expect(gets).toHaveLength(3);
    for (const g of gets) expect(g).toContain("${ITEMS_URL_SUFFIX}");
  });

  it("AddItemInput searches locally, not via the network", () => {
    const src = read("components/AddItemInput.tsx");
    expect(src).not.toContain("/items/search");
    expect(src).not.toMatch(/fetch\(/);
    expect(src).toMatch(/useMemo\(\s*\(\)\s*=>\s*computeSuggestions\(listType, items, value\)/);
  });

  it("page passes items to AddItemInput", () => {
    const src = read("app/list/[id]/page.tsx");
    const start = src.indexOf("<AddItemInput");
    expect(start).toBeGreaterThan(-1);
    // props precede onAddItem; stay within the opening tag's first lines
    expect(src.slice(start, start + 160)).toMatch(/\bitems=\{items\}/);
  });
});
