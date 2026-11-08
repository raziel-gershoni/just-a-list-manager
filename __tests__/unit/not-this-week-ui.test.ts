import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";

// The paused row in the Recurring drawer, and the page wiring for "Not needed this week" (the
// button itself lives in the item sheet, covered by item-sheet.test.ts). Translations echo their key.
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ""}${key}${values ? JSON.stringify(values) : ""}`,
  useLocale: () => "en",
}));

import RecurringItemsSection from "@/components/list/RecurringItemsSection";
import CompletedItemsSection from "@/components/list/CompletedItemsSection";
import SkippedItemsSection from "@/components/list/SkippedItemsSection";

const PAUSE_LABEL = "items.recurring.notThisWeek";

describe("RecurringItemsSection: a paused staple", () => {
  const NOW = Date.parse("2026-11-12T15:00:00.000Z");
  const HOUR = 60 * 60 * 1000;
  const item = (id: string, over: Partial<ItemData>): ItemData => ({
    id, text: id, completed: true, completed_at: new Date(NOW - HOUR).toISOString(), deleted_at: null,
    skipped_at: null, ordered_at: null, recurring: true, position: 1,
    created_by: null, creator_name: null, edited_by: null, editor_name: null, ...over,
  });
  const render = (items: ItemData[]) =>
    renderToStaticMarkup(
      createElement(RecurringItemsSection, {
        recurringItems: items, showRecurring: true, setShowRecurring: () => {},
        onRestoreRecurring: () => {}, onToggleRecurring: () => {},
      })
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("says Not needed this week and is not struck through like a bought one", () => {
    const html = render([
      item("Bread", {}),
      item("Milk", { paused_until: new Date(NOW + 2 * 24 * HOUR).toISOString() }),
    ]);
    expect(html).toContain(PAUSE_LABEL);
    expect(html).toContain("items.recurring.returnsInHours");
    expect(html.match(/line-through/g)).toHaveLength(1);
    expect(html).toMatch(/line-through[^>]*>Bread</);
  });

  it("says Returning soon once its week has ended and the list has not reloaded yet", () => {
    const html = render([item("Milk", { paused_until: new Date(NOW - 60_000).toISOString() })]);
    expect(html).toContain("items.recurring.returningSoon");
    expect(html).not.toContain(PAUSE_LABEL);
  });
});

describe("quantity in the drawers", () => {
  const item = (over: Partial<ItemData>): ItemData => ({
    id: "x", text: "Milk", completed: true, completed_at: new Date().toISOString(), deleted_at: null,
    skipped_at: null, ordered_at: null, recurring: true, position: 1,
    created_by: null, creator_name: null, edited_by: null, editor_name: null, ...over,
  });
  const render = (items: ItemData[]) =>
    renderToStaticMarkup(
      createElement(RecurringItemsSection, {
        recurringItems: items, showRecurring: true, setShowRecurring: () => {},
        onRestoreRecurring: () => {}, onToggleRecurring: () => {},
      })
    );
  it("the Recurring drawer shows a staple's quantity, and nothing when it has none", () => {
    expect(render([item({ quantity: "2 L" })])).toMatch(/data-qty[^>]*>2 L</);
    expect(render([item({ quantity: null })])).not.toContain("data-qty");
  });

  it("the Recurring drawer caps the quantity so a long one cannot squeeze the name", () => {
    expect(render([item({ quantity: "2 L" })])).toMatch(/max-w-\[40%\][^>]*>2 L</);
  });

  const renderCompleted = (items: ItemData[], showQuantity: boolean) =>
    renderToStaticMarkup(
      createElement(CompletedItemsSection, {
        completedItems: items, completedGroups: [{ label: "Today", items }], showCompleted: true,
        setShowCompleted: () => {}, duplicateTexts: new Set<string>(), isShared: false, userId: null,
        showQuantity, onToggle: () => {}, onDelete: () => {}, onEdit: () => {}, onClearCompleted: () => {},
      })
    );

  it("the Completed drawer shows the quantity only on a list that shows it", () => {
    const items = [item({ quantity: "2 L" })];
    expect(renderCompleted(items, true)).toContain(">2 L<");
    expect(renderCompleted(items, false)).not.toContain("data-qty");
  });

  const renderSkipped = (items: ItemData[]) =>
    renderToStaticMarkup(
      createElement(SkippedItemsSection, {
        skippedItems: items, showSkipped: true, setShowSkipped: () => {}, duplicateTexts: new Set<string>(),
        isShared: false, userId: null, onToggle: () => {}, onDelete: () => {}, onEdit: () => {},
        onSkip: () => {}, onOpenDetails: () => {},
      })
    );

  it("the Not available drawer shows each row's quantity and opens the sheet from the row", () => {
    const skipped = (over: Partial<ItemData>) => item({ completed: false, completed_at: null, skipped_at: new Date().toISOString(), ...over });
    expect(renderSkipped([skipped({ quantity: "3" })])).toContain(">3<");
    expect(renderSkipped([skipped({ quantity: null })])).not.toContain("data-qty");
    expect(renderSkipped([skipped({})])).toContain('role="button"');
  });
});

describe("the item sheet owns the pause", () => {
  const page = readFileSync(resolve(__dirname, "../../app/(app)/list/[id]/page.tsx"), "utf8");
  const sortable = readFileSync(resolve(__dirname, "../../components/SortableItem.tsx"), "utf8");

  it("the page hands it to the sheet", () => {
    expect(page).toMatch(/onPause=\{handlePause\}/);
  });

  it("SortableItem no longer carries it (the row has no pause button)", () => {
    expect(sortable).not.toMatch(/onPause/);
  });

  it("SortableItem has no onSkip either: it never renders a Not available row", () => {
    expect(sortable).not.toMatch(/onSkip/);
  });
});
