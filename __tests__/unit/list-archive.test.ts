import { describe, it, expect } from "vitest";
import { filterListsByView } from "@/src/utils/list-archive";

const lists = [
  { id: "active-1" },
  { id: "archived-1" },
  { id: "active-2" },
  { id: "archived-2" },
];
const archived = new Set(["archived-1", "archived-2"]);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("filterListsByView", () => {
  it("excludes archived lists from the active view", () => {
    expect(ids(filterListsByView(lists, archived, "active"))).toEqual([
      "active-1",
      "active-2",
    ]);
  });

  it("returns only archived lists in the archived view", () => {
    expect(ids(filterListsByView(lists, archived, "archived"))).toEqual([
      "archived-1",
      "archived-2",
    ]);
  });

  it("treats a list with no archive entry as active", () => {
    expect(ids(filterListsByView(lists, new Set(), "active"))).toEqual(ids(lists));
  });

  it("returns nothing in the archived view when nothing is archived", () => {
    expect(filterListsByView(lists, new Set(), "archived")).toEqual([]);
  });

  it("preserves input order", () => {
    const reversed = [...lists].reverse();
    expect(ids(filterListsByView(reversed, archived, "active"))).toEqual([
      "active-2",
      "active-1",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = ids(lists);
    filterListsByView(lists, archived, "archived");
    expect(ids(lists)).toEqual(before);
  });
});
