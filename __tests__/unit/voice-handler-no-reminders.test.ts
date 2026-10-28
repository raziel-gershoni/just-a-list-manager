import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Source inspection, like voice-categorize-wiring: handleVoiceMessage needs Telegram, Gemini
// and Supabase, so it can't run in node. Reminders are gone (spec 2026-10-28): a voice note
// only adds or removes items and never reads the user's time zone.
const src = readFileSync(resolve(process.cwd(), "src/services/voice-handler.ts"), "utf8");

describe("voice handler without reminders", () => {
  it("never writes or cancels a reminder row", () => {
    expect(src).not.toContain("item_reminders");
    expect(src).not.toMatch(/remind_at|recurrence/);
  });

  it("reads only the user's id and language", () => {
    expect(src).toContain('.select("id, language")');
    expect(src).not.toMatch(/timezone/i);
  });

  it("passes only the audio and the list names to the processor", () => {
    expect(src).toMatch(/processor\.process\(audioBuffer, listNames\)/);
  });
});
