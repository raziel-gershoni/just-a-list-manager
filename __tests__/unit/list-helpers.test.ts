// Pin a zone with daylight saving so the calendar-day tests are deterministic and
// can cross a 23-hour day. Must run before any Date is created in this file.
process.env.TZ = "Asia/Jerusalem";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { groupByCompletionTime } from "@/src/utils/list-helpers";
import type { ItemData } from "@/src/types";

const t = (key: string) => key;

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    text: "test item",
    completed: true,
    completed_at: new Date().toISOString(),
    deleted_at: null,
    skipped_at: null,
    ordered_at: null,
    recurring: false,
    position: 1,
    created_by: null,
    creator_name: null,
    edited_by: null,
    editor_name: null,
    ...overrides,
  };
}

/** Local wall-clock time in the pinned zone (month is 1-12). */
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min);
}

/** Label of the single group the item lands in, with "now" at the given local time. */
function labelAt(now: Date, completedAt: Date | null): string {
  vi.setSystemTime(now);
  const result = groupByCompletionTime(
    [makeItem({ completed_at: completedAt ? completedAt.toISOString() : null })],
    t
  );
  expect(result).toHaveLength(1);
  return result[0].label.replace("items.completedTime.", "");
}

describe("groupByCompletionTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs in a zone with daylight saving (guards the DST cases below)", () => {
    expect(local(2026, 7, 1).getTimezoneOffset()).toBe(-180);
    expect(local(2026, 12, 1).getTimezoneOffset()).toBe(-120);
  });

  it("returns empty array for empty items", () => {
    expect(groupByCompletionTime([], t)).toEqual([]);
  });

  it("puts last night's item under Yesterday the next morning", () => {
    expect(labelAt(local(2026, 10, 27, 8, 0), local(2026, 10, 26, 22, 0))).toBe("yesterday");
  });

  it("puts an item from 23:59 under Yesterday two minutes later", () => {
    expect(labelAt(local(2026, 10, 27, 0, 1), local(2026, 10, 26, 23, 59))).toBe("yesterday");
  });

  it("keeps an item from just after midnight under Today late that evening", () => {
    expect(labelAt(local(2026, 10, 27, 23, 30), local(2026, 10, 27, 0, 30))).toBe("today");
  });

  it("puts an item from two calendar days ago under A few days ago", () => {
    expect(labelAt(local(2026, 10, 27, 8, 0), local(2026, 10, 25, 22, 0))).toBe("daysAgo");
  });

  it.each([
    [6, "daysAgo"],
    [7, "weekAgo"],
    [13, "weekAgo"],
    [14, "weeksAgo"],
    [29, "weeksAgo"],
    [30, "monthAgo"],
    [59, "monthAgo"],
    [60, "monthsAgo"],
    [179, "monthsAgo"],
    [180, "longAgo"],
  ])("puts an item from %i calendar days ago under %s", (days, expected) => {
    const now = local(2026, 10, 27, 12, 0);
    const completed = local(2026, 10, 27 - days, 12, 0);
    expect(labelAt(now, completed)).toBe(expected);
  });

  it("counts calendar days across the 23-hour spring-forward day", () => {
    // 2027-03-26 has 23 hours in Israel: 00:10 that day to 00:30 the next is
    // only 23h20m, but it is still yesterday.
    expect(labelAt(local(2027, 3, 27, 0, 30), local(2027, 3, 26, 0, 10))).toBe("yesterday");
  });

  it("puts an item completed a little in the future (clock skew) under Today", () => {
    expect(labelAt(local(2026, 10, 27, 8, 0), local(2026, 10, 27, 8, 2))).toBe("today");
  });

  it("places item with null completed_at into 'longAgo'", () => {
    expect(labelAt(local(2026, 10, 27), null)).toBe("longAgo");
  });

  it("groups multiple items in the same bucket together", () => {
    vi.setSystemTime(local(2026, 10, 27, 12, 0));
    const item1 = makeItem({ text: "a", completed_at: local(2026, 10, 27, 9, 0).toISOString() });
    const item2 = makeItem({ text: "b", completed_at: local(2026, 10, 27, 10, 0).toISOString() });
    const result = groupByCompletionTime([item1, item2], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
    expect(result[0].items).toEqual([item1, item2]);
  });

  it("returns only non-empty groups, oldest first", () => {
    vi.setSystemTime(local(2026, 10, 27, 12, 0));
    const todayItem = makeItem({ text: "today", completed_at: local(2026, 10, 27, 9, 0).toISOString() });
    const longAgoItem = makeItem({ text: "long ago", completed_at: null });
    const yesterdayItem = makeItem({ text: "yesterday", completed_at: local(2026, 10, 26, 9, 0).toISOString() });

    const result = groupByCompletionTime([todayItem, longAgoItem, yesterdayItem], t);
    expect(result.map((g) => g.label)).toEqual([
      "items.completedTime.longAgo",
      "items.completedTime.yesterday",
      "items.completedTime.today",
    ]);
  });
});
