import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// The approve:/decline: branch in handleCallbackQuery correctly guards by
// list-owner telegram id before acting. The three reminder_* branches did
// not guard at all: Telegram callback_data is chosen by the client at the
// protocol level, so a modified client could send any reminder id and have
// the server act on it — completing an item or rescheduling a reminder in a
// list the sender has no relationship to. Each branch must now verify the
// sender holds "edit" rights on the reminder's list (via verifyListPermission)
// before doing anything with the reminder it looked up.
//
// handleCallbackQuery needs a live bot + database to execute, so this is a
// source-inspection test (pattern: recycle-scoping.test.ts,
// no-deleted-item-leak.test.ts) rather than a behavioral one.
describe("handleCallbackQuery reminder_* branches require edit permission", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/services/bot.ts"),
    "utf8"
  );

  // Anchors for the three reminder_* branches. NOTE: naively anchoring the
  // apply-snooze branch on 'data.match(/^reminder_snooze:' would match the
  // FIRST occurrence — the show-buttons branch — not the apply branch. Anchor
  // on something unique to the apply branch instead (its duration group).
  const doneAnchor = 'data.startsWith("reminder_done:")';
  const showAnchor = "data.match(/^reminder_snooze:[^:]+$/)";
  const applyAnchor = "data.match(/^reminder_snooze:[^:]+:(30m";

  const doneStart = source.indexOf(doneAnchor);
  const showStart = source.indexOf(showAnchor);
  const applyStart = source.indexOf(applyAnchor);

  it("all three branch anchors are found, in source order", () => {
    expect(doneStart).toBeGreaterThanOrEqual(0);
    expect(showStart).toBeGreaterThan(doneStart);
    expect(applyStart).toBeGreaterThan(showStart);
  });

  const doneSlice = source.slice(doneStart, showStart);
  const showSlice = source.slice(showStart, applyStart);
  const applySlice = source.slice(applyStart);

  it("slices are non-empty and don't bleed into the next branch", () => {
    expect(doneSlice.length).toBeGreaterThan(0);
    expect(showSlice.length).toBeGreaterThan(0);
    expect(applySlice.length).toBeGreaterThan(0);
    // The done slice must not accidentally swallow the show-buttons branch.
    expect(doneSlice).not.toContain("editMessageReplyMarkup");
    // The show slice must not accidentally swallow the apply branch.
    expect(showSlice).not.toContain("newRemindAt");
  });

  it("reminder_done:<id> verifies edit permission before writing to items", () => {
    expect(doneSlice).toContain("verifyListPermission");
    const permIdx = doneSlice.indexOf("verifyListPermission");

    // Pin the argument, not just presence + ordering: indexOf("verifyListPermission")
    // being before the write says nothing about which list_id it checked. A
    // permission check on the WRONG list (e.g. the caller's own list, per
    // Finding 1's laundering bug) would satisfy the ordering check while
    // leaving the actual hole open.
    expect(doneSlice).toMatch(/verifyListPermission\([^,]+,\s*reminder\.list_id,/);

    const recurringWriteIdx = doneSlice.indexOf("completeRecurringItem(supabase");
    const oneTimeWriteIdx = doneSlice.indexOf(".update({ completed: true");
    expect(recurringWriteIdx).toBeGreaterThan(0);
    expect(oneTimeWriteIdx).toBeGreaterThan(0);

    expect(
      permIdx,
      "verifyListPermission must run before completeRecurringItem is called"
    ).toBeLessThan(recurringWriteIdx);
    expect(
      permIdx,
      "verifyListPermission must run before the item is marked completed"
    ).toBeLessThan(oneTimeWriteIdx);
  });

  it("reminder_snooze:<id> (show buttons) verifies edit permission before responding", () => {
    // Read-only (just shows buttons), but a bare reminder id still lets an
    // attacker probe whether a given reminder id exists in ANY list — gate it too.
    expect(showSlice).toContain("verifyListPermission");
    // Pin the argument (see the identical note on the reminder_done test above).
    expect(showSlice).toMatch(/verifyListPermission\([^,]+,\s*reminder\.list_id,/);
  });

  it("reminder_snooze:<id>:<duration> (apply) verifies edit permission before writing to item_reminders", () => {
    expect(applySlice).toContain("verifyListPermission");
    const permIdx = applySlice.indexOf("verifyListPermission");

    // Pin the argument (see the identical note on the reminder_done test above).
    expect(applySlice).toMatch(/verifyListPermission\([^,]+,\s*reminder\.list_id,/);

    const writeIdx = applySlice.indexOf("remind_at: newRemindAt.toISOString()");
    expect(writeIdx).toBeGreaterThan(0);

    expect(
      permIdx,
      "verifyListPermission must run before item_reminders is updated"
    ).toBeLessThan(writeIdx);
  });

  it("the permission-denial guard's OWN early return resolves through reminder.notFound (not merely present somewhere in the branch)", () => {
    // Scoped to a tight window around each guard's own `if (!may...) { ... return; }`,
    // not the whole slice — the whole slice trivially contains "reminder.notFound"
    // via the earlier `if (!reminder)` row-missing branch above it, which would
    // make this assertion pass even if the permission guard used a different
    // (or no) message. Pin it to the guard itself.
    const doneGuard = doneSlice.match(/if\s*\(!mayComplete\)[\s\S]{0,200}?return;/);
    const showGuard = showSlice.match(/if\s*\(!maySnooze\)[\s\S]{0,200}?return;/);
    const applyGuard = applySlice.match(/if\s*\(!maySnooze\)[\s\S]{0,200}?return;/);

    for (const guard of [doneGuard, showGuard, applyGuard]) {
      expect(guard).toBeTruthy();
      expect(guard![0]).toContain('"reminder.notFound"');
      expect(guard![0]).not.toMatch(/not allowed|permission denied|forbidden/i);
    }
  });

  // The tests above (verifyListPermission called with the right args, role
  // checks present) all pass even if the `if (!mayComplete) { ...; return; }`
  // / `if (!maySnooze) { ...; return; }` blocks are deleted outright, leaving
  // only the `const mayComplete =` / `const maySnooze =` declarations — an
  // unused, dead computation. That reopens the exact hole this file exists to
  // close: the sender's role is computed but never enforced. Assert the
  // guard's early return actually exists and actually precedes the write it
  // guards.
  it("reminder_done's mayComplete guard early-returns before either completion write", () => {
    const guardMatch = doneSlice.match(/if\s*\(!mayComplete\)[\s\S]{0,200}?return;/);
    expect(guardMatch).toBeTruthy();
    const guardIdx = doneSlice.indexOf(guardMatch![0]);

    const recurringWriteIdx = doneSlice.indexOf("completeRecurringItem(supabase");
    const oneTimeWriteIdx = doneSlice.indexOf(".update({ completed: true");
    expect(recurringWriteIdx).toBeGreaterThan(0);
    expect(oneTimeWriteIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(recurringWriteIdx);
    expect(guardIdx).toBeLessThan(oneTimeWriteIdx);
  });

  it("the show-buttons branch's maySnooze guard early-returns before the reply markup is edited", () => {
    const guardMatch = showSlice.match(/if\s*\(!maySnooze\)[\s\S]{0,200}?return;/);
    expect(guardMatch).toBeTruthy();
    const guardIdx = showSlice.indexOf(guardMatch![0]);

    const writeIdx = showSlice.indexOf("editMessageReplyMarkup");
    expect(writeIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(writeIdx);
  });

  it("the apply-snooze branch's maySnooze guard early-returns before item_reminders is updated", () => {
    const guardMatch = applySlice.match(/if\s*\(!maySnooze\)[\s\S]{0,200}?return;/);
    expect(guardMatch).toBeTruthy();
    const guardIdx = applySlice.indexOf(guardMatch![0]);

    const writeIdx = applySlice.indexOf("remind_at: newRemindAt.toISOString()");
    expect(writeIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(writeIdx);
  });

  it("mayComplete cannot be satisfied by created_by — a future edit must not quietly let a viewer complete an item they merely created a reminder for", () => {
    expect(doneSlice.indexOf("const mayComplete")).toBeGreaterThan(0);
    expect(doneSlice).not.toMatch(/mayComplete[\s\S]{0,120}created_by/);
  });

  it("imports verifyListPermission from the shared api-auth module", () => {
    expect(source).toContain('verifyListPermission');
    expect(source).toMatch(/import\s*\{[^}]*verifyListPermission[^}]*\}\s*from\s*["']@\/src\/lib\/api-auth["']/);
  });

  // A view-only collaborator can legitimately create a personal reminder
  // (the create route only requires "view"), but requiring "edit" on every
  // reminder_* branch broke that: both of that viewer's own buttons answered
  // "Reminder not found" on a reminder they created themselves. The fix calls
  // verifyListPermission at the "view" bar in every branch and then decides
  // per-branch from `role`: reminder_done writes to `items` (shared state),
  // so it still requires owner/editor; the snooze branches only ever touch
  // this one reminder row, so they also allow the reminder's own creator.
  it("all three branches call verifyListPermission at the \"view\" bar", () => {
    for (const slice of [doneSlice, showSlice, applySlice]) {
      expect(slice).toMatch(/verifyListPermission\([^,]+,\s*reminder\.list_id,\s*"view"\)/);
    }
  });

  it("reminder_done requires owner or editor role — created_by alone is not enough", () => {
    expect(doneSlice).toMatch(/perm\.role\s*===\s*"owner"/);
    expect(doneSlice).toMatch(/perm\.role\s*===\s*"editor"/);

    // The gate guarding the writes must be the role-derived decision, not the
    // raw perm.allowed (which a view-only collaborator also satisfies).
    const recurringWriteIdx = doneSlice.indexOf("completeRecurringItem(supabase");
    const oneTimeWriteIdx = doneSlice.indexOf(".update({ completed: true");
    const roleCheckIdx = doneSlice.search(/perm\.role\s*===\s*"owner"/);
    expect(roleCheckIdx).toBeGreaterThan(0);
    expect(roleCheckIdx).toBeLessThan(recurringWriteIdx);
    expect(roleCheckIdx).toBeLessThan(oneTimeWriteIdx);
  });

  it("both snooze branches (show + apply) also allow the reminder's own creator", () => {
    for (const slice of [showSlice, applySlice]) {
      expect(slice).toMatch(/perm\.role\s*===\s*"owner"/);
      expect(slice).toMatch(/perm\.role\s*===\s*"editor"/);
      expect(slice).toMatch(/reminder\.created_by\s*===\s*botUser\?\.id/);
    }
  });

  it("the show-buttons branch selects created_by so it can apply the creator fallback", () => {
    // Its reminder lookup used to select only "id, list_id" — without
    // created_by in the row, the creator-fallback check has nothing to read.
    const selectIdx = showSlice.indexOf('.from("item_reminders")');
    expect(selectIdx).toBeGreaterThan(0);
    const selectSlice = showSlice.slice(selectIdx, selectIdx + 200);
    expect(selectSlice).toMatch(/\.select\([^)]*created_by[^)]*\)/);
  });
});
