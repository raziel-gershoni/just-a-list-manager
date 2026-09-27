import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// 9551051 removed this identical bug from clear-completed: cancelling a
// reminder right after a soft-delete is lossy when the only undo path PATCHes
// just deleted_at back to null and never un-cancels anything. DELETE
// /api/lists/[id]/items has the same shape — it called cancelItemReminders
// right after the soft-delete, and both undo paths that restore from it
// (useItemHandlers.ts single-delete undo and remove-duplicates undo) only
// ever PATCH { deleted_at: null }. The cron already cancels a reminder whose
// item is soft-deleted once it comes due (app/api/cron/reminders/route.ts),
// and the digest filters out items with no live reminders
// (app/api/cron/digest/route.ts), so nothing fires for a row that stays
// deleted — cancelling here was therefore both unnecessary and lossy for undo.
describe("DELETE /api/lists/[id]/items", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/api/lists/[id]/items/route.ts"),
    "utf8"
  );

  it("does not cancel reminders on single-item delete (undo only restores deleted_at, never un-cancels)", () => {
    expect(source).not.toContain("cancelItemReminders");
  });

  it("does not import cancelItemReminders now that nothing in this file calls it", () => {
    expect(source).not.toMatch(/import\s*\{[^}]*cancelItemReminders[^}]*\}/);
  });
});
