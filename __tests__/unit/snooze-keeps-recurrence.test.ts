import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Snoozing used to clear `recurrence`. That was correct when written (46df943,
// 2026-04-18): the cron then auto-advanced a recurring reminder on the same
// item when it fired, so a snoozed one spawned a second chain (migration 018
// cleaned that up). cebd7ca (2026-04-21) removed the auto-advance and moved
// occurrence creation to Done, but the snooze branch was never revisited: from
// then on, clearing the recurrence didn't prevent a duplicate chain, it just
// ended the series.
// See docs/superpowers/specs/2026-09-15-recurring-occurrence-integrity-design.md
describe("reminder snooze", () => {
  const source = readFileSync(resolve(process.cwd(), "src/services/bot.ts"), "utf8");

  // Anchored on the apply branch's own regex fragment, not the shared
  // "data.match(/^reminder_snooze:" prefix — that prefix also matches the
  // unrelated show-snooze-buttons branch above it, and indexOf finds the first
  // occurrence.
  const snoozeUpdate = source.slice(
    source.indexOf('data.match(/^reminder_snooze:[^:]+:(30m'),
    source.indexOf("// Get user timezone and language for display")
  );

  it("locates the snooze handler", () => {
    expect(snoozeUpdate.length).toBeGreaterThan(0);
    expect(snoozeUpdate).toContain("remind_at: newRemindAt.toISOString()");
  });

  it("does not clear the recurrence when snoozing", () => {
    expect(snoozeUpdate).not.toContain("recurrence: null");
  });

  it("still clears sent_at so the snoozed reminder fires again", () => {
    expect(snoozeUpdate).toContain("sent_at: null");
  });

  // Regression: `source.indexOf('data.match(/^reminder_snooze:')` matches the
  // FIRST occurrence of that prefix, which is the unrelated show-snooze-buttons
  // branch (its regex is `/^reminder_snooze:[^:]+$/`), not the snooze-apply
  // branch (`/^reminder_snooze:[^:]+:(30m|1h|3h|tomorrow)$/`). That widened the
  // slice by the whole show-buttons handler. `inline_keyboard` only appears in
  // that handler, so its absence here proves the slice starts in the right place.
  it("does not bleed into the unrelated show-snooze-buttons branch", () => {
    expect(snoozeUpdate).not.toContain("inline_keyboard");
  });
});

// Snooze overwrites remind_at in place, and Done computes the next occurrence
// from it, so without a recorded anchor one 30m snooze shifts every future
// occurrence. anchor_at remembers the original series slot.
describe("reminder snooze series anchor", () => {
  const source = readFileSync(resolve(process.cwd(), "src/services/bot.ts"), "utf8");
  const apply = source.slice(
    source.indexOf('data.match(/^reminder_snooze:[^:]+:(30m'),
    source.indexOf("// Get user timezone and language for display")
  );

  it("selects anchor_at on the reminder it snoozes", () => {
    expect(apply).toMatch(/\.select\("[^"]*\banchor_at\b[^"]*"\)/);
  });

  it("records the series slot, keeping the original across repeated snoozes", () => {
    expect(apply).toContain("anchor_at: reminder.anchor_at ?? reminder.remind_at");
  });

  it("never prefers the (possibly already snoozed) remind_at over an existing anchor", () => {
    expect(apply).not.toContain("reminder.remind_at ?? reminder.anchor_at");
    expect(apply).not.toMatch(/anchor_at:\s*reminder\.remind_at\s*[,}\n]/);
    expect(apply).not.toMatch(/anchor_at:\s*reminder\.anchor_at\s*[,}\n]/);
  });
});
