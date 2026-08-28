import { describe, it, expect } from "vitest";
import { decideReminderDelivery } from "@/src/utils/reminder-suppression";

const DELETED = "2026-08-01T00:00:00.000Z";

describe("decideReminderDelivery", () => {
  it("cancels when the list is soft-deleted", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("cancels a deleted list even when nobody archived it", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "cancel" });
  });

  it("sends to everyone when nobody archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1", "u2"],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "send", recipients: ["u1", "u2"] });
  });

  it("drops only the recipients who archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
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
        recipients: ["u1", "u2"],
        archivedBy: new Set(["u1", "u2"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent for a personal reminder whose creator archived the list", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("stamps sent when there are no recipients at all", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: null,
        recipients: [],
        archivedBy: new Set(),
      })
    ).toEqual({ kind: "stamp-sent" });
  });

  it("prefers cancel over stamp-sent when the list is both deleted and archived", () => {
    expect(
      decideReminderDelivery({
        listDeletedAt: DELETED,
        recipients: ["u1"],
        archivedBy: new Set(["u1"]),
      })
    ).toEqual({ kind: "cancel" });
  });
});
