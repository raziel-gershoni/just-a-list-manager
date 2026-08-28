import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

// Migration 025 renames list_order -> user_list_state. A leftover reference
// compiles fine and fails only at runtime, as a silent empty result from
// PostgREST, so scan for it.
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(full)) acc.push(full);
  }
  return acc;
}

describe("list_order table rename", () => {
  it("no source file queries the old list_order table", () => {
    const root = process.cwd();
    const roots = ["app", "src", "components"].map((d) => resolve(root, d));
    const offenders: string[] = [];

    for (const dir of roots) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, "utf8");
        if (/["'`]list_order["'`]/.test(text)) {
          offenders.push(file.replace(root + "/", ""));
        }
      }
    }

    expect(
      offenders,
      `these files still reference the renamed table "list_order" (now "user_list_state"): ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
