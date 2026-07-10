import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { LIST_COLORS } from "@/src/lib/list-icons";

const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("list color CSS tokens", () => {
  // Guards the silent-break bug: adding a LIST_COLORS name but forgetting its
  // --list-<name> token in one theme block renders that theme with no accent.
  it("defines a --list-<name> token for every color in BOTH themes (:root + .dark)", () => {
    for (const name of LIST_COLORS) {
      const count = (css.match(new RegExp(`--list-${name}\\s*:`, "g")) || []).length;
      expect(
        count,
        `--list-${name} must be defined in both :root and .dark (found ${count})`
      ).toBeGreaterThanOrEqual(2);
    }
  });
});
