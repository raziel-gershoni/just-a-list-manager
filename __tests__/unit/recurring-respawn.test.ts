import { describe, it, expect } from "vitest";
import {
  RESPAWN_AFTER_MS,
  respawnAnchor,
  shouldRespawn,
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
});
