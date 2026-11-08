import { describe, it, expect } from "vitest";
import { sortsIntoCategories } from "@/src/utils/categories-switch";

describe("sortsIntoCategories", () => {
  it.each([
    [{ type: "grocery", categories_enabled: true }, true],
    [{ type: "grocery", categories_enabled: false }, false],
    // Unknown is not on: a read that left the column out must never spend AI.
    [{ type: "grocery" }, false],
    [{ type: "grocery", categories_enabled: null }, false],
    [{ type: "regular", categories_enabled: true }, false],
    [null, false],
    [undefined, false],
  ])("%j → %s", (list, expected) => {
    expect(sortsIntoCategories(list)).toBe(expected);
  });
});
