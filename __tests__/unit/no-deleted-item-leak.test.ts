import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Deleting is final (docs/superpowers/specs/2026-09-08-delete-is-final-design.md).
// GET used to widen to `.or("deleted_at.is.null,recurring.eq.true")` so the client
// could respawn soft-deleted recurring rows. That made a recurring item impossible
// to delete and kept the 7-day purge cron from ever reaching it. A reintroduction
// compiles fine and fails only as returning-from-the-dead rows in production.
describe("GET /api/lists/[id]/items", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/api/lists/[id]/items/route.ts"),
    "utf8"
  );

  it("does not widen the item query to include soft-deleted recurring rows", () => {
    expect(source).not.toContain("recurring.eq.true");
  });

  // Scoped to the GET body on purpose: `.is("deleted_at", null)` already exists
  // elsewhere in this file (the PATCH guard), so an unscoped assertion would pass
  // before the fix and catch no regression.
  it("filters the item list query to non-deleted rows", () => {
    const getFn = source.slice(
      source.indexOf("export async function GET"),
      source.indexOf("export async function POST")
    );
    expect(getFn.length).toBeGreaterThan(0);
    expect(getFn).toContain('.is("deleted_at", null)');
    expect(getFn).not.toContain(".or(");
  });
});
