import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// useListDragDrop is a React hook and vitest runs in node with no jsdom, so the
// grouped branch of handleDragEnd is pinned by reading its source. The drop
// math itself is tested behaviorally in grouped-drop.test.ts; this file pins
// what the hook does with the result.
const hook = readFileSync(resolve(process.cwd(), "src/hooks/useListDragDrop.ts"), "utf8");

// The `{ ... }` block that starts at the first "{" at or after `anchor`, with
// line comments and quoted or template strings skipped so neither an apostrophe
// in a comment nor a `${...}` shifts the depth.
function blockAt(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `"${anchor}" not found in useListDragDrop.ts`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    if (c === "`" || c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced block after "${anchor}"`);
}

describe("useListDragDrop grouped drops", () => {
  it("restores the pre-drag items and stops when a grouped drop lands nowhere", () => {
    const grouped = blockAt(hook, "if (groups) {");
    expect(grouped).toMatch(/computeGroupedDrop\(groups, sourceId, /);
    const noDrop = blockAt(grouped, "if (!drop) {");
    expect(noDrop).toMatch(/setItems\(previousItemsRef\.current\);/);
    expect(noDrop).toMatch(/\breturn;/);
  });

  it("sends set-category only for a move into another category", () => {
    expect(hook.match(/type: "set-category"/g)).toHaveLength(1);
    expect(blockAt(hook, "if (moveTo) {")).toMatch(/type: "set-category"/);
  });

  it("shows the moved item in its new category, placed by hand, before the server answers", () => {
    expect(hook).toMatch(
      /if \(moveTo && item\.id === sourceId\) next = \{ \.\.\.next, category_id: moveTo, category_locked: true \};/
    );
  });

  it("recomputes handleDragEnd when the groups change", () => {
    const end = hook.slice(hook.indexOf("const handleDragEnd"), hook.indexOf("return { handleDragStart"));
    const deps = end.match(/\[([^\]]*)\]\s*\);\s*$/);
    expect(deps, "handleDragEnd's useCallback deps array not found").not.toBeNull();
    expect(deps![1]).toMatch(/\bgroups\b/);
  });
});
