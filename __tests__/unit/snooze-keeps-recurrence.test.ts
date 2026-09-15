import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Snoozing used to clear `recurrence`, on the premise that "the next recurring
// instance was already created when this reminder fired". That was never true —
// the cron only stamps sent_at/cancelled_at; the next occurrence is created on
// Done. So clearing it silently ended the series.
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
