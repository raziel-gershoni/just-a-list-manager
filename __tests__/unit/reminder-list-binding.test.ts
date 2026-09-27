import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// item_reminders declares item_id and list_id as two INDEPENDENT FKs
// (supabase/migrations/014_item_reminders.sql) — nothing in the schema
// constrains a reminder's list_id to actually match its item's own
// items.list_id. The reminder-create route took both ids straight off the
// URL path and inserted them without ever checking they agree, so a
// view-only collaborator on list B could create their own list A, POST
// /api/lists/A/items/<itemIdInB>/reminder, and get back a reminder that
// is scoped (for permission purposes) to A but completes/reads an item
// in B. reminder_done in bot.ts then wrote to that item with no list_id
// scoping at all, so a valid callback on the laundered reminder silently
// completed an item in a list the caller never had rights to touch — and
// the cron would deliver B's item text to them with zero bot interaction.
//
// Both layers must hold: the route must refuse to create a reminder whose
// item doesn't belong to the given list (closes the leak at the source,
// including the cron-delivery path), and the one-time completion write
// must be defensively scoped by list_id too, matching its recurring
// sibling (completeRecurringItem, src/services/recurring.ts).
describe("item_reminders list binding", () => {
  describe("POST /api/lists/[id]/items/[itemId]/reminder", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "app/api/lists/[id]/items/[itemId]/reminder/route.ts"
      ),
      "utf8"
    );

    const postFn = source.slice(
      source.indexOf("export async function POST"),
      source.indexOf("export async function GET")
    );

    it("POST body is non-empty and isolated from GET", () => {
      expect(postFn.length).toBeGreaterThan(0);
    });

    it("verifies the item belongs to the list before inserting the reminder", () => {
      // Must look the item up scoped by BOTH its own id and the URL's listId —
      // an unscoped-by-list lookup (or none at all) is exactly what let a
      // mismatched item_id/list_id pair reach the insert.
      expect(postFn).toMatch(/\.from\("items"\)/);
      const itemsLookupIdx = postFn.indexOf('.from("items")');
      expect(itemsLookupIdx).toBeGreaterThan(0);
      const lookupSlice = postFn.slice(itemsLookupIdx, itemsLookupIdx + 300);
      expect(lookupSlice).toContain('.eq("id", itemId)');
      expect(lookupSlice).toContain('.eq("list_id", listId)');
    });

    it("runs the item/list check before the insert, and 404s when it fails", () => {
      const lookupIdx = postFn.indexOf('.from("items")');
      const insertIdx = postFn.indexOf('.from("item_reminders")\n    .insert(');
      expect(lookupIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(0);
      expect(
        lookupIdx,
        "the item/list check must run before the item_reminders insert"
      ).toBeLessThan(insertIdx);
      expect(postFn).toMatch(/status:\s*404/);
    });

    it("runs the check after the permission check, not before", () => {
      const permIdx = postFn.indexOf("verifyListPermission");
      const lookupIdx = postFn.indexOf('.from("items")');
      expect(permIdx).toBeGreaterThan(0);
      expect(lookupIdx).toBeGreaterThan(permIdx);
    });
  });

  describe("reminder_done one-time completion write (src/services/bot.ts)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/bot.ts"),
      "utf8"
    );

    const doneStart = source.indexOf('data.startsWith("reminder_done:")');
    const showStart = source.indexOf(
      "data.match(/^reminder_snooze:[^:]+$/)"
    );
    const doneSlice = source.slice(doneStart, showStart);

    it("branch anchors found", () => {
      expect(doneStart).toBeGreaterThanOrEqual(0);
      expect(showStart).toBeGreaterThan(doneStart);
    });

    it("the one-time completion update is scoped by list_id, matching completeRecurringItem", () => {
      const updateIdx = doneSlice.indexOf(".update({ completed: true");
      expect(updateIdx).toBeGreaterThan(0);
      // Look at the statement itself, not the whole branch — scope the slice
      // to the .update(...)....eq(...) chain that follows.
      const stmtSlice = doneSlice.slice(updateIdx, updateIdx + 300);
      expect(stmtSlice).toContain('.eq("id", reminder.item_id)');
      expect(stmtSlice).toContain('.eq("list_id", reminder.list_id)');
    });
  });
});
