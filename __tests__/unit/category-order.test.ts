import { describe, it, expect } from "vitest";
import { orderWithNewCategories } from "@/src/utils/category-order";

describe("orderWithNewCategories", () => {
  it("first scan: keeps the AI's walk order when every new category has after=null", () => {
    expect(orderWithNewCategories([], [
      { ref: "n1", after: null }, { ref: "n2", after: null }, { ref: "n3", after: null },
    ])).toEqual(["n1", "n2", "n3"]);
  });

  it("inserts after the named existing key or earlier new ref", () => {
    expect(orderWithNewCategories(["c1", "c2", "c3"], [
      { ref: "n1", after: "c1" }, { ref: "n2", after: "n1" },
    ])).toEqual(["c1", "n1", "n2", "c2", "c3"]);
  });

  it("puts after=null first, and appends an unknown 'after' at the end", () => {
    expect(orderWithNewCategories(["c1", "c2"], [
      { ref: "n1", after: null }, { ref: "n2", after: "zz" },
    ])).toEqual(["n1", "c1", "c2", "n2"]);
  });

  it("keeps the listed order when an after=null category follows one chained into the leading run", () => {
    expect(orderWithNewCategories(["c1"], [
      { ref: "n1", after: null }, { ref: "n2", after: "n1" }, { ref: "n3", after: null },
    ])).toEqual(["n1", "n2", "n3", "c1"]);
  });
});
