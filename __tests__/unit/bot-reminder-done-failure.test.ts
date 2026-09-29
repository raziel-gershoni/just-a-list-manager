import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Telegram Done used to discard completeRecurringItem's outcome and always answer
// "Done" and strip the buttons. On failure the claim is released (item active
// again) but the reminder has already been sent, so the item stalled with no
// button to retry. The failure path must answer reminder.failed and return
// WITHOUT editing the message, so the Done button survives and a re-tap retries.

const src = readFileSync(resolve(process.cwd(), "src/services/bot.ts"), "utf8");
const start = src.indexOf('data.startsWith("reminder_done:")');
const end = src.indexOf("data.match(/^reminder_snooze:[^:]+$/)");
const branch = src.slice(start, end);

describe("reminder_done failure handling (source inspection)", () => {
  it("finds the branch slice", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("captures the recurring outcome and bails before editing on error", () => {
    expect(branch).toMatch(/const outcome = await completeRecurringItem\(/);
    const check = branch.indexOf('outcome.status === "error"');
    expect(check).toBeGreaterThan(-1);
    const block = branch.slice(check, branch.indexOf("} else {", check));
    expect(block).toContain('getMsg(lang, "reminder.failed")');
    expect(block).toContain("return;");
    expect(block).not.toContain("editMessageText");
    expect(check).toBeLessThan(branch.indexOf("editMessageText"));
  });

  it("captures the one-time update error and bails the same way", () => {
    expect(branch).toMatch(/const \{ error: completeError \} = await supabase\s*\.from\("items"\)\s*\.update\(/);
    const check = branch.indexOf("if (completeError)");
    expect(check).toBeGreaterThan(-1);
    const block = branch.slice(check, branch.indexOf("editMessageText"));
    expect(block).toContain('getMsg(lang, "reminder.failed")');
    expect(block).toContain("return;");
    // The failure return comes before the success answer/edit.
    expect(check).toBeLessThan(branch.lastIndexOf('getMsg(lang, "reminder.done")'));
  });

  it("one-time path hands off to the shared helper before its plain update, and error keeps the button", () => {
    const elseIdx = branch.indexOf("} else {", branch.indexOf("outcome.status"));
    const oneTime = branch.slice(elseIdx);
    const call = oneTime.indexOf("completeItemRespectingRecurrence(supabase");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(oneTime.indexOf(".update("));
    expect(oneTime).toContain("itemId: reminder.item_id");
    expect(oneTime).toContain("listId: reminder.list_id");
    const check = oneTime.indexOf('handoff.status === "error"');
    expect(check).toBeGreaterThan(call);
    expect(check).toBeLessThan(oneTime.indexOf(".update("));
    // The error block itself: from its condition up to the next handoff branch.
    const block = oneTime.slice(check, oneTime.indexOf('handoff.status === "not-recurring"', check));
    expect(block).toContain('getMsg(lang, "reminder.failed")');
    expect(block).not.toContain("editMessageText");
    // It must return before its own closing brace, or a failed hand-off falls
    // through to the false "Done" answer and message edit.
    expect(block).toMatch(/reminder\.failed"[^;]*\);\s*return;\s*\}\s*(?:if \(|$)/);
    // plain update only runs for not-recurring
    expect(oneTime.slice(check)).toContain('handoff.status === "not-recurring"');
  });
});
