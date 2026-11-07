import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  RESPAWN_AFTER_MS,
  respawnAnchor,
  respawnAt,
  shouldRespawn,
  weekEnd,
} from "@/src/utils/recurring-respawn";

const NOW = new Date("2026-09-08T12:00:00.000Z").getTime();
const FIVE_HOURS_AGO = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
const ONE_HOUR_AGO = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();

describe("respawnAnchor", () => {
  it("is null for a non-recurring item", () => {
    expect(respawnAnchor({ recurring: false, completed_at: FIVE_HOURS_AGO })).toBe(null);
  });

  it("is the completion time for a completed recurring item", () => {
    expect(respawnAnchor({ recurring: true, completed_at: FIVE_HOURS_AGO })).toBe(
      FIVE_HOURS_AGO
    );
  });

  it("is null for a deleted recurring item — deleting is final", () => {
    expect(
      respawnAnchor({ recurring: true, completed_at: null, deleted_at: FIVE_HOURS_AGO })
    ).toBe(null);
  });

  it("is null when an item was completed and then deleted", () => {
    expect(
      respawnAnchor({
        recurring: true,
        completed_at: FIVE_HOURS_AGO,
        deleted_at: ONE_HOUR_AGO,
      })
    ).toBe(null);
  });

  it("is null for an active recurring item that has never been completed", () => {
    expect(respawnAnchor({ recurring: true, completed_at: null, deleted_at: null })).toBe(
      null
    );
  });
});

describe("shouldRespawn", () => {
  it("respawns a recurring item completed more than four hours ago", () => {
    expect(shouldRespawn({ recurring: true, completed_at: FIVE_HOURS_AGO }, NOW)).toBe(true);
  });

  it("does not respawn a recurring item completed one hour ago", () => {
    expect(shouldRespawn({ recurring: true, completed_at: ONE_HOUR_AGO }, NOW)).toBe(false);
  });

  it("never respawns a deleted item, however old the delete", () => {
    const ancient = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldRespawn({ recurring: true, deleted_at: ancient }, NOW)).toBe(false);
  });

  it("never respawns a deleted item whose stale completion is older than the window", () => {
    expect(
      shouldRespawn(
        { recurring: true, completed_at: FIVE_HOURS_AGO, deleted_at: ONE_HOUR_AGO },
        NOW
      )
    ).toBe(false);
  });

  it("never respawns a non-recurring completed item", () => {
    expect(shouldRespawn({ recurring: false, completed_at: FIVE_HOURS_AGO }, NOW)).toBe(false);
  });

  it("treats a missing recurring flag as not recurring", () => {
    expect(shouldRespawn({ completed_at: FIVE_HOURS_AGO }, NOW)).toBe(false);
  });

  it("exports the four-hour window", () => {
    expect(RESPAWN_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("does not respawn when the anchor is exactly the respawn window old (pins > over >=)", () => {
    const exactlyAtWindow = new Date(NOW - RESPAWN_AFTER_MS).toISOString();
    expect(shouldRespawn({ recurring: true, completed_at: exactlyAtWindow }, NOW)).toBe(
      false
    );
  });
});

describe("a paused staple (Not needed this week)", () => {
  const paused = (until: number, completedAt = FIVE_HOURS_AGO) => ({
    recurring: true,
    completed_at: completedAt,
    paused_until: new Date(until).toISOString(),
  });

  it("stays parked until its week ends, even more than four hours after it was paused", () => {
    expect(shouldRespawn(paused(NOW + 60_000), NOW)).toBe(false);
  });

  it("comes back once its week has ended", () => {
    expect(shouldRespawn(paused(NOW - 60_000), NOW)).toBe(true);
  });

  it("is not back at the exact end of the week (pins > over >=, like the four-hour rule)", () => {
    expect(shouldRespawn(paused(NOW), NOW)).toBe(false);
  });

  it("comes back at the week's end even when that is sooner than four hours (paused on Saturday evening)", () => {
    expect(shouldRespawn(paused(NOW - 1000, ONE_HOUR_AGO), NOW)).toBe(true);
  });

  it("never comes back once deleted — deleting is final", () => {
    expect(shouldRespawn({ ...paused(NOW - 60_000), deleted_at: ONE_HOUR_AGO }, NOW)).toBe(false);
  });

  it("never comes back for a row that no longer repeats", () => {
    expect(shouldRespawn({ ...paused(NOW - 60_000), recurring: false }, NOW)).toBe(false);
  });
});

describe("respawnAt", () => {
  it("is the end of the pause for a paused staple", () => {
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO, paused_until: "2026-09-13T21:00:00.000Z" }))
      .toBe(Date.parse("2026-09-13T21:00:00.000Z"));
  });

  it("is four hours after the tick for a bought staple", () => {
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO })).toBe(Date.parse(ONE_HOUR_AGO) + RESPAWN_AFTER_MS);
  });

  it("falls back to four hours after the tick when paused_until can't be read", () => {
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO, paused_until: "garbage" }))
      .toBe(Date.parse(ONE_HOUR_AGO) + RESPAWN_AFTER_MS);
  });

  it("is null for an item that never comes back on its own", () => {
    expect(respawnAt({ recurring: false, completed_at: ONE_HOUR_AGO })).toBe(null);
    expect(respawnAt({ recurring: true, completed_at: null })).toBe(null);
    expect(respawnAt({ recurring: true, completed_at: ONE_HOUR_AGO, paused_until: "2026-09-13T21:00:00.000Z", deleted_at: ONE_HOUR_AGO })).toBe(null);
  });
});

// The week ends at Sunday 00:00 on the phone's clock (an Israeli week). Run in Israel time so the
// two DST weeks are real: clocks go forward on Fri 27 Mar 2026 and back on Sun 25 Oct 2026.
describe("weekEnd (Israel time)", () => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "Asia/Jerusalem";
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it.each([
    ["Sunday morning", "2026-11-08T08:00:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["Thursday evening", "2026-11-12T17:00:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["Saturday 23:30", "2026-11-14T21:30:00.000Z", "2026-11-14T22:00:00.000Z"],
    ["exactly Sunday 00:00 (the next week's end)", "2026-11-14T22:00:00.000Z", "2026-11-21T22:00:00.000Z"],
    ["the week the clocks go forward", "2026-03-25T10:00:00.000Z", "2026-03-28T21:00:00.000Z"],
    ["the week the clocks go back", "2026-10-24T21:00:00.000Z", "2026-10-31T22:00:00.000Z"],
  ])("%s", (_label, now, end) => {
    expect(weekEnd(new Date(now)).toISOString()).toBe(end);
  });

  it("is never more than a week and an hour away (the server's bound)", () => {
    const now = Date.parse("2026-10-24T21:00:00.000Z");
    expect(weekEnd(new Date(now)).getTime() - now).toBe(7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  });
});
