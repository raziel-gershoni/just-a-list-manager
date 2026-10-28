import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/hooks/useRealtimeList.ts"), "utf8");

// The subscribe status callbacks are not try/catch handlers, so the no-silent-catches
// guard cannot see them. This pins that a failed subscription is logged with its error.
describe("realtime subscribe status callbacks log failures", () => {
  it("resubscribe callback takes (status, err) and warns before the settled early-return", () => {
    const at = src.indexOf("channel.subscribe((status");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/^channel\.subscribe\(\(status, err\) => \{/);
    const warnAt = body.indexOf("console.warn(");
    const settledAt = body.indexOf("if (settled) return;");
    expect(warnAt).toBeGreaterThan(-1);
    expect(settledAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(settledAt);
    const before = body.slice(0, settledAt);
    expect(before).toMatch(/status === "CHANNEL_ERROR" \|\| status === "TIMED_OUT"/);
    expect(before).toMatch(/console\.warn\([^;]*\berr\b\)/);
  });

  it("initial subscribe callback takes (status, err) and warns on CHANNEL_ERROR/TIMED_OUT", () => {
    const first = src.indexOf("channel.subscribe((status");
    const at = src.indexOf("channel.subscribe((status", first + 1);
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 600);
    expect(body).toMatch(/^channel\.subscribe\(\(status, err\) => \{/);
    expect(body).toMatch(/status === "CHANNEL_ERROR" \|\| status === "TIMED_OUT"/);
    expect(body).toMatch(/console\.warn\([^;]*\berr\b\)/);
  });
});
