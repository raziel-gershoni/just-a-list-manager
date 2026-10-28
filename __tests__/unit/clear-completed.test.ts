import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { computeClearCompleted } from "@/src/utils/clear-completed";
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

// "Clear completed" must preserve the original feature contract (commit bea02b3):
// recurring staples auto-respawn "4 hours after being completed or cleared." Since
// delete-is-final vetoes respawn on deleted_at, soft-deleting a parked recurring row
// here would retire it permanently instead of just returning it to its completion
// clock. See docs/superpowers/specs/2026-09-08-delete-is-final-design.md.
describe("computeClearCompleted", () => {
  it("does not select a parked recurring item for clearing", () => {
    const staple = item({
      id: "staple",
      completed: true,
      completed_at: "2026-07-01T00:00:00Z",
      recurring: true,
    });
    const { cleared, remaining } = computeClearCompleted([staple]);

    expect(cleared).toEqual([]);
    expect(remaining).toEqual([staple]);
  });

  it("selects a completed, non-recurring, non-deleted item for clearing", () => {
    const done = item({ id: "done", completed: true, completed_at: "2026-07-01T00:00:00Z" });
    const { cleared, remaining } = computeClearCompleted([done]);

    expect(cleared).toEqual([done]);
    expect(remaining).toEqual([]);
  });

  it("leaves active and already-deleted items alone", () => {
    const active = item({ id: "active" });
    const deleted = item({
      id: "deleted",
      completed: true,
      deleted_at: "2026-07-01T00:00:00Z",
    });
    const { cleared, remaining } = computeClearCompleted([active, deleted]);

    expect(cleared).toEqual([]);
    expect(remaining).toEqual([active, deleted]);
  });

  it("separates a mix, preserving order in both arrays", () => {
    const staple = item({ id: "staple", completed: true, recurring: true });
    const done = item({ id: "done", completed: true });
    const active = item({ id: "active" });
    const { cleared, remaining } = computeClearCompleted([staple, done, active]);

    expect(cleared).toEqual([done]);
    expect(remaining).toEqual([staple, active]);
  });
});

// Source-inspection: the server must apply the same exclusion, or the client's
// optimistic view (and the undo toast's count) will disagree with what was
// actually soft-deleted. Pattern follows __tests__/unit/no-deleted-item-leak.test.ts.
describe("POST /api/lists/[id]/items/clear-completed", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/api/lists/[id]/items/clear-completed/route.ts"),
    "utf8"
  );

  it("excludes recurring rows from the clear query", () => {
    expect(source).toContain('.eq("recurring", false)');
  });
});
