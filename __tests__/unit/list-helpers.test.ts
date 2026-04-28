import { describe, it, expect } from "vitest";
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
    recurring: false,
    position: 1,
    created_by: null,
    creator_name: null,
    edited_by: null,
    editor_name: null,
    ...overrides,
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/*
 * Bucket logic in groupByCompletionTime:
 * Buckets are iterated oldest-first. An item is placed in the first bucket
 * where age >= bucket.maxAge.
 *
 *   longAgo:   age >= Infinity  (only null completed_at -> age=Infinity)
 *   monthsAgo: age >= 180d
 *   monthAgo:  age >= 60d
 *   weeksAgo:  age >= 30d
 *   weekAgo:   age >= 14d
 *   daysAgo:   age >= 7d
 *   yesterday:  age >= 2d
 *   today:     age >= 1d  (or fallback for age < 1d)
 */

describe("groupByCompletionTime", () => {
  it("returns empty array for empty items", () => {
    const result = groupByCompletionTime([], t);
    expect(result).toEqual([]);
  });

  it("places item completed just now into 'today' bucket", () => {
    const item = makeItem({ completed_at: ago(1000) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
    expect(result[0].items).toContain(item);
  });

  it("places item completed 1.5 days ago into 'today' bucket (age >= 1d)", () => {
    const item = makeItem({ completed_at: ago(1.5 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
  });

  it("places item completed 3 days ago into 'yesterday' bucket (age >= 2d)", () => {
    const item = makeItem({ completed_at: ago(3 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.yesterday");
  });

  it("places item completed 10 days ago into 'daysAgo' bucket (age >= 7d)", () => {
    const item = makeItem({ completed_at: ago(10 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.daysAgo");
  });

  it("places item completed 20 days ago into 'weekAgo' bucket (age >= 14d)", () => {
    const item = makeItem({ completed_at: ago(20 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.weekAgo");
  });

  it("places item completed 45 days ago into 'weeksAgo' bucket (age >= 30d)", () => {
    const item = makeItem({ completed_at: ago(45 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.weeksAgo");
  });

  it("places item completed 90 days ago into 'monthAgo' bucket (age >= 60d)", () => {
    const item = makeItem({ completed_at: ago(90 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.monthAgo");
  });

  it("places item completed 200 days ago into 'monthsAgo' bucket (age >= 180d)", () => {
    const item = makeItem({ completed_at: ago(200 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.monthsAgo");
  });

  it("places item with null completed_at into 'longAgo' bucket (age = Infinity)", () => {
    const item = makeItem({ completed_at: null });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.longAgo");
  });

  it("groups multiple items in the same bucket together", () => {
    const item1 = makeItem({ text: "a", completed_at: ago(1000) });
    const item2 = makeItem({ text: "b", completed_at: ago(2000) });
    const result = groupByCompletionTime([item1, item2], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
    expect(result[0].items).toHaveLength(2);
  });

  it("returns groups in oldest-first order", () => {
    const todayItem = makeItem({ text: "today", completed_at: ago(1000) });
    const longAgoItem = makeItem({
      text: "long ago",
      completed_at: null,
    });
    const yesterdayItem = makeItem({
      text: "yesterday",
      completed_at: ago(3 * DAY),
    });

    const result = groupByCompletionTime(
      [todayItem, longAgoItem, yesterdayItem],
      t
    );
    expect(result).toHaveLength(3);
    expect(result[0].label).toBe("items.completedTime.longAgo");
    expect(result[1].label).toBe("items.completedTime.yesterday");
    expect(result[2].label).toBe("items.completedTime.today");
  });

  it("places item at exactly 1d boundary into 'today' bucket", () => {
    // age = exactly 1 * DAY, bucket today has maxAge=1*DAY, so age >= maxAge -> today
    const item = makeItem({ completed_at: ago(DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
  });

  it("places item at exactly 2d boundary into 'yesterday' bucket", () => {
    // age = exactly 2 * DAY, bucket yesterday has maxAge=2*DAY, so age >= maxAge -> yesterday
    const item = makeItem({ completed_at: ago(2 * DAY) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.yesterday");
  });

  it("places item just under 2d into 'today' bucket", () => {
    const item = makeItem({ completed_at: ago(2 * DAY - 1) });
    const result = groupByCompletionTime([item], t);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("items.completedTime.today");
  });

  it("omits empty groups from result", () => {
    const item = makeItem({ completed_at: ago(1000) });
    const result = groupByCompletionTime([item], t);
    // Only one group should be returned (today), not all 8
    expect(result).toHaveLength(1);
  });
});
