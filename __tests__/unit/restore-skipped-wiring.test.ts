import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Source inspection: vitest runs in node with no jsdom, so the React side can't be
// rendered. These pin the two links a refactor could silently drop: the page passing
// the handler into the section, and the header button calling it without toggling
// the section open or closed.

const page = readFileSync(resolve(process.cwd(), "app/list/[id]/page.tsx"), "utf8");
const section = readFileSync(resolve(process.cwd(), "components/list/SkippedItemsSection.tsx"), "utf8");

describe("Restore all wiring", () => {
  it("the list page takes handleRestoreSkipped from useItemHandlers and hands it to SkippedItemsSection", () => {
    const call = page.indexOf("useItemHandlers(");
    expect(call).toBeGreaterThan(-1);
    const destructure = page.slice(page.lastIndexOf("const {", call), call);
    expect(destructure).toContain("handleSkip,");
    expect(destructure).toContain("handleRestoreSkipped");

    const start = page.indexOf("<SkippedItemsSection");
    expect(start).toBeGreaterThan(-1);
    const element = page.slice(start, page.indexOf("/>", start));
    expect(element).toContain("onRestoreAll={handleRestoreSkipped}");
  });

  it("the section header renders a Restore all button that calls onRestoreAll and stops the toggle", () => {
    const start = section.indexOf("{onRestoreAll && (");
    expect(start).toBeGreaterThan(-1);
    const button = section.slice(start, section.indexOf("</button>", start));
    expect(button).toMatch(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*onRestoreAll\(\);\s*\}\}/);
    expect(button).toContain("t('items.restoreAll')");

    // The header's own onClick only toggles the section.
    const header = section.slice(section.indexOf("<button"), start);
    expect(header).toContain("setShowSkipped");
    expect(header).not.toContain("onRestoreAll()");
  });
});
