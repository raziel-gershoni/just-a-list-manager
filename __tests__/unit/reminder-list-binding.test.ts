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

    // Finding 1(a): the item-text read for the confirmation message/idempotency
    // guard used to look the item up by item_id alone. On a laundered
    // (mismatched) row that silently returns another list's item, and the
    // pre-existing `item?.text || "Item"` fallback masked the null instead of
    // denying the request — so the branch went on to answer a false "done"
    // confirmation for an item it never touched.
    it("the item-text read is scoped by list_id, not item_id alone", () => {
      const selectIdx = doneSlice.indexOf(
        '.select("text, completed, completed_at")'
      );
      expect(selectIdx).toBeGreaterThan(0);
      const selectSlice = doneSlice.slice(selectIdx, selectIdx + 200);
      expect(selectSlice).toContain('.eq("id", reminder.item_id)');
      expect(selectSlice).toContain('.eq("list_id", reminder.list_id)');
    });

    it("bails through reminder.notFound (not a silent fallback) when the scoped item read comes back empty", () => {
      const selectIdx = doneSlice.indexOf(
        '.select("text, completed, completed_at")'
      );
      expect(selectIdx).toBeGreaterThan(0);
      const afterSelect = doneSlice.slice(selectIdx, selectIdx + 700);
      expect(afterSelect).toMatch(
        /if\s*\(!item\)[\s\S]{0,200}"reminder\.notFound"[\s\S]{0,80}return;/
      );
      // The old masking fallback must be gone — a mismatch must not silently
      // render "Item" as if the completion actually happened.
      expect(afterSelect).not.toMatch(/item\?\.text\s*\|\|\s*"Item"/);
    });
  });

  describe("reminder_snooze apply branch item-text read (src/services/bot.ts)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/services/bot.ts"),
      "utf8"
    );
    // Last branch in the file — slicing to EOF is safe (same anchor used by
    // reminder-callback-auth.test.ts).
    const applyAnchor = "data.match(/^reminder_snooze:[^:]+:(30m";
    const applyStart = source.indexOf(applyAnchor);
    const applySlice = source.slice(applyStart);

    it("branch anchor found", () => {
      expect(applyStart).toBeGreaterThan(0);
    });

    it("widens the items join to also fetch the item's own list_id", () => {
      const joinIdx = applySlice.indexOf("items!inner(");
      expect(joinIdx).toBeGreaterThan(0);
      const joinSlice = applySlice.slice(joinIdx, joinIdx + 40);
      expect(joinSlice).toMatch(/items!inner\([^)]*text[^)]*list_id[^)]*\)/);
    });

    // Finding 1(b): a mismatched row let the snooze-apply branch read and
    // echo back another list's item text in the confirmation message, with
    // no write required — just tapping "Snooze 30m" on a laundered reminder.
    it("bails through reminder.notFound on a list_id mismatch before the item text is used", () => {
      const joinIdx = applySlice.indexOf("items!inner(");
      const itemTextIdx = applySlice.indexOf("const itemText");
      expect(joinIdx).toBeGreaterThan(0);
      expect(itemTextIdx).toBeGreaterThan(joinIdx);

      const between = applySlice.slice(joinIdx, itemTextIdx + 80);
      expect(between).toMatch(/list_id\s*!==\s*reminder\.list_id/);
      expect(between).toMatch(/"reminder\.notFound"/);
      expect(between).toMatch(/return;/);
    });
  });

  describe("cron reminders mismatch handling (app/api/cron/reminders/route.ts)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/cron/reminders/route.ts"),
      "utf8"
    );

    it("already selects the item's own list_id for comparison", () => {
      expect(source).toMatch(/items!inner\([^)]*list_id[^)]*\)/);
    });

    // Finding 1(c): the select already fetched item.list_id but never
    // compared it. Must run alongside the completed/deleted checks, before
    // recipients are resolved, and — because this cron has a .limit(50) due
    // window — an unstamped skip would occupy a slot forever and starve real
    // reminders, so it must stamp cancelled_at rather than bare `continue`.
    it("checks item.list_id against reminder.list_id before resolving creator/recipients", () => {
      const mismatchIdx = source.search(/item\.list_id\s*!==\s*reminder\.list_id/);
      expect(mismatchIdx).toBeGreaterThan(0);

      const creatorCommentIdx = source.indexOf("// Get creator info");
      expect(creatorCommentIdx).toBeGreaterThan(0);
      expect(mismatchIdx).toBeLessThan(creatorCommentIdx);

      const deletedCheckIdx = source.indexOf("if (item.deleted_at)");
      expect(deletedCheckIdx).toBeGreaterThan(0);
      expect(mismatchIdx).toBeGreaterThan(deletedCheckIdx);
    });

    it("stamps cancelled_at before continuing on a mismatch (never an unstamped skip)", () => {
      const mismatchIdx = source.search(/item\.list_id\s*!==\s*reminder\.list_id/);
      expect(mismatchIdx).toBeGreaterThan(0);
      const afterMismatch = source.slice(mismatchIdx, mismatchIdx + 400);

      const stampIdx = afterMismatch.search(
        /cancelled_at:\s*new Date\(\)\.toISOString\(\)/
      );
      expect(stampIdx).toBeGreaterThan(0);
      const continueIdx = afterMismatch.indexOf("continue;");
      expect(continueIdx).toBeGreaterThan(stampIdx);
    });
  });

  describe("cron digest mismatch handling (app/api/cron/digest/route.ts)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/cron/digest/route.ts"),
      "utf8"
    );

    // Finding 1(d): liveReminders already excludes completed/deleted items and
    // archived lists. Widen the item select to include list_id and fold the
    // same mismatch check into that filter so a laundered row never reaches
    // the digest message either.
    it("selects the item's own list_id alongside its other fields", () => {
      expect(source).toMatch(/items!inner\([^)]*list_id[^)]*\)/);
    });

    it("the liveReminders filter excludes a list_id mismatch", () => {
      const filterIdx = source.indexOf("const liveReminders =");
      expect(filterIdx).toBeGreaterThan(0);
      const filterSlice = source.slice(filterIdx, filterIdx + 700);
      expect(filterSlice).toMatch(/item\.list_id\s*===\s*list\.id/);
    });
  });
});
