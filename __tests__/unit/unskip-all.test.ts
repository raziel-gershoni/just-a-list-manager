import { describe, it, expect } from "vitest";
import { computeUnskipAll } from "@/src/utils/unskip-all";
import type { ItemData } from "@/src/types";

// Full-shape ItemData factory so the fixtures stay valid if the interface grows.
function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: "x",
    completed: false,
    completed_at: null,
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

describe("computeUnskipAll", () => {
  it("clears skipped_at only on items in the Not available section", () => {
    const items = [
      item({ id: "skipped", skipped_at: "2026-10-08T08:00:00Z" }),
      item({ id: "active" }),
      // Stale flags the section doesn't show: a completed or deleted row that still carries skipped_at.
      item({ id: "completed", completed: true, completed_at: "2026-10-08T09:00:00Z", skipped_at: "2026-10-08T08:00:00Z" }),
      item({ id: "deleted", deleted_at: "2026-10-08T09:00:00Z", skipped_at: "2026-10-08T08:00:00Z" }),
    ];

    const { next, affectedIds } = computeUnskipAll(items);

    expect(affectedIds).toEqual(["skipped"]);
    expect(next[0]).toMatchObject({ id: "skipped", skipped_at: null, completed: false, position: 0 });
    expect(next[1]).toBe(items[1]);
    expect(next[2]).toBe(items[2]);
    expect(next[3]).toBe(items[3]);
  });

  it("keeps the order of affected ids", () => {
    const items = [
      item({ id: "a", skipped_at: "2026-10-08T08:00:00Z" }),
      item({ id: "b" }),
      item({ id: "c", skipped_at: "2026-10-08T07:00:00Z" }),
    ];
    expect(computeUnskipAll(items).affectedIds).toEqual(["a", "c"]);
  });

  it("returns no affected ids when nothing is skipped", () => {
    const items = [item({ id: "a" })];
    const { next, affectedIds } = computeUnskipAll(items);
    expect(affectedIds).toEqual([]);
    expect(next[0]).toBe(items[0]);
  });
});
