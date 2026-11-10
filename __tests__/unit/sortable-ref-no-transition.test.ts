import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// dnd-kit 0.4+ copies the sortable ref element's computed `transition` onto the dragged
// element after splitting it on commas. Tailwind's transition/ease classes compute to a
// cubic-bezier(a, b, c, d) value, which that split mangles, so the pickup animation snaps.
// The ref element therefore carries no transition; the drag look sits on an inner div.

const ROOT = join(__dirname, "..", "..");

// Every component that calls useSortable, with the expression passed to the element's `ref`.
const SORTABLES: Record<string, string> = {
  "components/SortableItem.tsx": "ref",
  "components/SortableListCard.tsx": "setCardRef",
  "components/list/CategoriesSheet.tsx": "ref",
};

function filesUsingSortable(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUsingSortable(rel));
    else if (/\.tsx?$/.test(entry.name) && /\buseSortable\s*\(/.test(readFileSync(join(ROOT, rel), "utf8"))) out.push(rel);
  }
  return out;
}

// The full opening tag that holds `ref={expr}`, even when it spans several lines.
function openingTag(src: string, refExpr: string): string {
  const at = src.indexOf(`ref={${refExpr}}`);
  if (at < 0) throw new Error(`ref={${refExpr}} not found`);
  const start = src.lastIndexOf("<", at);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated tag for ref={${refExpr}}`);
}

describe("sortable ref elements carry no CSS transition", () => {
  it("covers every component that calls useSortable", () => {
    expect(filesUsingSortable("components").sort()).toEqual(Object.keys(SORTABLES).sort());
  });

  for (const [file, refExpr] of Object.entries(SORTABLES)) {
    it(`${file}: the ref={${refExpr}} element has no transition or ease class`, () => {
      const tag = openingTag(readFileSync(join(ROOT, file), "utf8"), refExpr);
      expect(tag).not.toMatch(/(^|[\s"'`:])(transition|ease-)/);
    });
  }
});
