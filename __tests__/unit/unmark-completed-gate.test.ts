import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "app/api/lists/[id]/items/unmark-completed/route.ts"),
  "utf8"
);

describe("unmark-completed type gate (source inspection)", () => {
  it("reads the list type and rejects reminders with 400 before any update", () => {
    const read = src.indexOf('.from("lists")');
    expect(read).toBeGreaterThan(-1);
    expect(src.slice(read)).toContain('.select("type")');
    const gate = src.indexOf('list?.type === "reminders"');
    expect(gate).toBeGreaterThan(read);
    const update = src.indexOf(".update(");
    expect(update).toBeGreaterThan(gate);
    expect(src.slice(gate, update)).toContain("status: 400");
  });

  it("a list-read error returns 500 before the bulk update", () => {
    const check = src.indexOf("if (listError)");
    expect(check).toBeGreaterThan(-1);
    const update = src.indexOf(".update(");
    expect(check).toBeLessThan(update);
    const block = src.slice(check, src.indexOf('if (list?.type === "reminders")'));
    expect(block).toContain("status: 500");
    expect(block).toContain("return NextResponse.json");
  });
});
