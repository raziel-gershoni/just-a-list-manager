import { describe, it, expect } from "vitest";
import { decideReminderDelivery } from "@/src/utils/reminder-suppression";

const NOW = new Date("2026-08-28T12:00:00.000Z").getTime();
const LONG_AGO = "2026-08-01T00:00:00.000Z";
const JUST_NOW = new Date(NOW - 3_000).toISOString();

describe("decideReminderDelivery", () => {
  it("cancels when the list is soft-deleted", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: LONG_AGO,
        now: NOW,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("cancels a deleted list even when nobody archived it", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: LONG_AGO,
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("sends to everyone when nobody archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        now: NOW,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "send", recipients: ["u1", "u2"] });
  });

  it("drops only the recipients who archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        now: NOW,
        recipients: ["u1", "u2", "u3"],
        archivedBy: new Set(["u2"]),
      })
    ).toEqual({ kind: "send", recipients: ["u1", "u3"] });
  });

  // Must be stamp-sent, not cancel: unarchiving should not resurrect a
  // past-due reminder, but the row must leave the cron's .limit(50) window or
  // it occupies a slot forever and eventually crowds out real reminders.
  it("stamps sent when every recipient archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        now: NOW,
        recipients: ["u1", "u2"],
        archivedBy: new Set(["u1", "u2"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent for a personal reminder whose creator archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent when there are no recipients at all", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        now: NOW,
        recipients: [],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("prefers cancel over stamp-sent when the list is both deleted and archived", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: LONG_AGO,
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "cancel" });
  });

  // Delete is optimistic with a 4s undo toast, and PATCH { restore: true } only
  // clears deleted_at -- it never un-cancels. The cron runs every minute, so
  // cancelling a just-deleted list's reminders would destroy them for good if a
  // tick landed inside the undo window.
  it("does not cancel a list deleted seconds ago, so the undo window survives", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: JUST_NOW,
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "send", recipients: ["u1"] });
  });

  it("cancels once the delete is older than the undo grace period", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: new Date(NOW - 120_000).toISOString(),
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("still suppresses for an archiver while a delete is inside the grace period", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: JUST_NOW,
        now: NOW,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });
});
