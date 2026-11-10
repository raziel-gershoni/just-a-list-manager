import { describe, it, expect } from "vitest";
import { createItemSchema } from "@/src/schemas/items";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `item ${i}` }));

describe("createItemSchema items", () => {
  // zod 4.6 only protects an array that declares a size cap, so the group add declares one.
  it("accepts 500 items in one add", () => {
    expect(createItemSchema.safeParse({ items: items(500) }).success).toBe(true);
  });

  it("rejects 501 items in one add", () => {
    expect(createItemSchema.safeParse({ items: items(501) }).success).toBe(false);
  });
});
