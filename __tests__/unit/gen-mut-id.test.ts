import { describe, it, expect } from "vitest";
import { genMutId, lookupUserName } from "@/src/utils/list-helpers";
import type { ItemData } from "@/src/types";

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    text: "test item",
    completed: false,
    completed_at: null,
    deleted_at: null,
    skipped_at: null,
    position: 1,
    created_by: null,
    creator_name: null,
    edited_by: null,
    editor_name: null,
    ...overrides,
  };
}

describe("genMutId", () => {
  it("returns a string starting with 'mut-'", () => {
    const id = genMutId();
    expect(id).toMatch(/^mut-/);
  });

  it("generates unique IDs on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(genMutId());
    }
    expect(ids.size).toBe(100);
  });

  it("returns a string value", () => {
    expect(typeof genMutId()).toBe("string");
  });
});

describe("lookupUserName", () => {
  it("returns null for null userId", () => {
    const items = [makeItem({ created_by: "u1", creator_name: "Alice" })];
    expect(lookupUserName(items, null)).toBeNull();
  });

  it("finds creator name matching userId", () => {
    const items = [makeItem({ created_by: "u1", creator_name: "Alice" })];
    expect(lookupUserName(items, "u1")).toBe("Alice");
  });

  it("finds editor name matching userId", () => {
    const items = [makeItem({ edited_by: "u2", editor_name: "Bob" })];
    expect(lookupUserName(items, "u2")).toBe("Bob");
  });

  it("returns null when userId is not found in any item", () => {
    const items = [
      makeItem({ created_by: "u1", creator_name: "Alice" }),
      makeItem({ edited_by: "u2", editor_name: "Bob" }),
    ];
    expect(lookupUserName(items, "u999")).toBeNull();
  });

  it("returns null for empty items array", () => {
    expect(lookupUserName([], "u1")).toBeNull();
  });

  it("prefers creator_name over editor_name when both match", () => {
    const items = [
      makeItem({
        created_by: "u1",
        creator_name: "Alice Creator",
        edited_by: "u1",
        editor_name: "Alice Editor",
      }),
    ];
    // The function checks created_by first
    expect(lookupUserName(items, "u1")).toBe("Alice Creator");
  });

  it("skips items where userId matches but name is null", () => {
    const items = [
      makeItem({ created_by: "u1", creator_name: null }),
      makeItem({ edited_by: "u1", editor_name: "Found" }),
    ];
    expect(lookupUserName(items, "u1")).toBe("Found");
  });
});
