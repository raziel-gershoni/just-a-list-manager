import { describe, it, expect } from "vitest";
import { createListSchema, updateListSchema, listTypeEnum } from "@/src/schemas/lists";
import {
  LIST_COLORS,
  LIST_ICONS,
  defaultColorFor,
  defaultIconFor,
  listAccentVar,
  resolveIcon,
  type ListType,
} from "@/src/lib/list-icons";

// The reminders list type was removed. Migration 029 later retires the value in the database,
// so until then a list an old app version made during the deploy can still carry it.

const LIST_ID = "0b8f6c1e-2f4a-4c3b-9d1e-000000000001";

// @ts-expect-error "reminders" is no longer a ListType, so this line must not compile
const retired: ListType = "reminders";
void retired;

describe("list type schemas", () => {
  it("offer exactly regular and grocery", () => {
    expect(listTypeEnum.options).toEqual(["regular", "grocery"]);
  });

  it("create rejects the reminders type", () => {
    expect(createListSchema.safeParse({ name: "Chores", type: "reminders" }).success).toBe(false);
  });

  it("update rejects the reminders type", () => {
    expect(updateListSchema.safeParse({ id: LIST_ID, type: "reminders" }).success).toBe(false);
  });

  it("still accept regular, grocery and no type at all", () => {
    expect(createListSchema.safeParse({ name: "Chores" }).success).toBe(true);
    expect(createListSchema.safeParse({ name: "Food", type: "grocery" }).success).toBe(true);
    expect(updateListSchema.safeParse({ id: LIST_ID, type: "regular" }).success).toBe(true);
  });
});

describe("list type defaults", () => {
  it("a list still stored as reminders gets the regular icon and colour", () => {
    const stale = "reminders" as unknown as ListType;
    expect(defaultIconFor(stale)).toBe("ListChecks");
    expect(defaultColorFor(stale)).toBe("slate");
    expect(resolveIcon(null, stale)).toBe(LIST_ICONS.ListChecks);
    expect(listAccentVar(null, stale)).toBe("var(--list-slate)");
  });

  it("keeps grocery and regular defaults", () => {
    expect(defaultIconFor("grocery")).toBe("ShoppingCart");
    expect(defaultColorFor("grocery")).toBe("emerald");
    expect(defaultIconFor("regular")).toBe("ListChecks");
    expect(defaultColorFor("regular")).toBe("slate");
  });

  it("keeps the Bell icon and the blue colour as picks for any list", () => {
    expect(resolveIcon("Bell", "regular")).toBe(LIST_ICONS.Bell);
    expect(LIST_COLORS).toContain("blue");
  });
});
