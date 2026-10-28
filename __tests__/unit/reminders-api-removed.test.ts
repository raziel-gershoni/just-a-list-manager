import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";

const exists = (p: string) => existsSync(resolve(process.cwd(), p));

// The reminder API is gone for good. A file coming back means the feature was half-restored.
describe("reminder API surface is removed", () => {
  it.each([
    "app/api/lists/[id]/items/[itemId]",
    "app/api/lists/[id]/items/[itemId]/reminder/route.ts",
    "app/api/lists/[id]/items/[itemId]/reminder/[reminderId]/route.ts",
    "app/api/lists/[id]/items/[itemId]/complete-recurring/route.ts",
    "app/api/lists/[id]/reminders",
    "app/api/lists/[id]/reminders/route.ts",
    "src/schemas/reminders.ts",
    "src/services/recurring.ts",
  ])("%s does not exist", (path) => {
    expect(exists(path)).toBe(false);
  });
});

// Names overlap with the reminders code, but this is the shared-list nudge and stays.
describe("the Remind/Ready nudge and grocery repeat are untouched", () => {
  it.each([
    "app/api/lists/[id]/remind/route.ts",
    "app/api/lists/[id]/ready/route.ts",
    "src/utils/recurring-respawn.ts",
  ])("%s still exists", (path) => {
    expect(exists(path)).toBe(true);
  });
});
