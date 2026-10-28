import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Reminders were removed from the client. These pin what is gone, and that the neighbours
// that share words with it (the grocery Repeat toggle, the Remind/Ready nudge toast, the
// pending Clock) are still there.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("reminder components are deleted", () => {
  it("ReminderSheet and TimePicker no longer exist", () => {
    expect(existsSync(resolve(process.cwd(), "components/ReminderSheet.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "components/TimePicker.tsx"))).toBe(false);
  });

  it("the wheel-picker package is neither a dependency nor in the lockfile", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).not.toContain("@ncdai/react-wheel-picker");
    const lock = JSON.parse(read("package-lock.json"));
    expect(Object.keys(lock.packages[""].dependencies)).not.toContain("@ncdai/react-wheel-picker");
    expect(lock.packages["node_modules/@ncdai/react-wheel-picker"]).toBeUndefined();
  });

  it("globals.css has no bell or wheel-picker rules, and its utilities layer still closes", () => {
    const css = read("app/globals.css");
    expect(css).not.toMatch(/bell-pulse|bell-ring|time-picker|data-rwp/);
    expect(css).not.toMatch(/set reminder/);
    // The rules before the deleted block are still there.
    expect(css).toContain("@keyframes dropdown-pop");
  });
});

describe("item rows carry no reminder UI", () => {
  const stripped = /reminderAt|onReminderTap|isOverdue|recurrence|formatShortTime|bell-pulse|\bBell\b/;

  it("ItemRow has no bell, time label or overdue state, but keeps Clock and Repeat", () => {
    const src = read("components/ItemRow.tsx");
    expect(src).not.toMatch(stripped);
    expect(src).toContain("<Clock");
    expect(src).toContain("<Repeat");
  });

  it("SortableItem no longer passes reminder props through", () => {
    expect(read("components/SortableItem.tsx")).not.toMatch(stripped);
  });

  it("CompletedItemsSection no longer passes reminder props to ItemRow", () => {
    const src = read("components/list/CompletedItemsSection.tsx");
    expect(src).not.toMatch(stripped);
    expect(src).not.toMatch(/my_remind|my_reminder/);
  });
});

describe("the list page and pickers have no Reminders type", () => {
  it("the list page has no reminders branch, sheet, state or handlers", () => {
    const src = read("app/list/[id]/page.tsx");
    expect(src).not.toMatch(
      /isReminders|ReminderSheet|ReminderItemsList|groupByDate|reminderItem|pendingReminderText|handleSetReminder|handleUpdateReminder|handleCancelReminder|my_remind|"reminders"|typeReminders/
    );
    // The nudge toast shares the word and must survive.
    expect(src).toContain("reminderToast={reminderToast}");
  });

  it("the add box is not told the list type", () => {
    const src = read("app/list/[id]/page.tsx");
    const start = src.indexOf("<AddItemInput");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf("/>", start))).not.toContain("listType");
  });

  it("the new-list picker offers no Reminders choice", () => {
    expect(read("app/page.tsx")).not.toMatch(/"reminders"|typeReminders/);
  });
});

describe("the add box", () => {
  it("always shows the normal placeholder and takes no list type", () => {
    const src = read("components/AddItemInput.tsx");
    expect(src).not.toMatch(/listType|reminders|addReminderPlaceholder/);
    expect(src).toContain("placeholder={t('items.addPlaceholder')}");
  });
});
