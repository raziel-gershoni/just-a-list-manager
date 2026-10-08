import { describe, it, expect } from "vitest";
import { categoryOrderSchema } from "@/src/schemas/categories";

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `0b8f6c1e-2f4a-4c3b-9d1e-${String(i).padStart(12, "0")}`);

describe("categoryOrderSchema", () => {
  // The reorder RPC demands the list's exact set; the zod max only bounds the payload, so a
  // list that somehow holds more than the 20-category cap can still be reordered.
  it("accepts an order longer than the 20-category cap", () => {
    expect(categoryOrderSchema.safeParse({ orderedIds: ids(21) }).success).toBe(true);
  });

  it("accepts up to 100 ids", () => {
    expect(categoryOrderSchema.safeParse({ orderedIds: ids(100) }).success).toBe(true);
  });

  it("rejects more than 100 ids", () => {
    expect(categoryOrderSchema.safeParse({ orderedIds: ids(101) }).success).toBe(false);
  });

  it("rejects an empty order", () => {
    expect(categoryOrderSchema.safeParse({ orderedIds: [] }).success).toBe(false);
  });
});
