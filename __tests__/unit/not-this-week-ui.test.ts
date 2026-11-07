import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ItemData } from "@/src/types";

// The row button, the paused row in the Recurring drawer, and the page wiring for "Not needed
// this week". Translations echo their key.
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ""}${key}${values ? JSON.stringify(values) : ""}`,
  useLocale: () => "en",
}));
// ItemRow runs as a plain function below, so its hooks need a stand-in outside a render.
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
  };
});

import ItemRow from "@/components/ItemRow";
import RecurringItemsSection from "@/components/list/RecurringItemsSection";

type El = { props: Record<string, unknown> & { children?: unknown } };
function findEl(node: unknown, pred: (el: El) => boolean): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (!el.props) return null;
  if (pred(el)) return el;
  return findEl(el.props.children, pred);
}

const PAUSE_LABEL = "items.recurring.notThisWeek";
const rowProps = (over: Record<string, unknown> = {}) => ({
  id: "a", text: "Milk", completed: false,
  onToggle: () => {}, onDelete: () => {}, onSkip: () => {}, onOrder: () => {}, onToggleRecurring: () => {},
  recurring: true, onPause: () => {},
  ...over,
});
const pauseButton = (props: Record<string, unknown>) =>
  findEl((ItemRow as (p: unknown) => unknown)(props), (el) => el.props["aria-label"] === PAUSE_LABEL);

describe("ItemRow: the Not needed this week button", () => {
  beforeEach(() => vi.stubGlobal("window", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("shows on a recurring row and pauses that item when tapped", () => {
    const onPause = vi.fn();
    const btn = pauseButton(rowProps({ onPause }));
    expect(btn).not.toBeNull();
    (btn!.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onPause).toHaveBeenCalledWith("a");
  });

  it("is not on a row that does not repeat", () => {
    expect(pauseButton(rowProps({ recurring: false }))).toBeNull();
  });

  it("is not on a ticked row", () => {
    expect(pauseButton(rowProps({ completed: true }))).toBeNull();
  });

  it("is not there when the list gives no pause handler (a regular list)", () => {
    expect(pauseButton(rowProps({ onPause: undefined }))).toBeNull();
  });

  it("sits between On the way and Repeat, as the owner chose", () => {
    const html = renderToStaticMarkup(createElement(ItemRow, rowProps() as never));
    const order = ["items.ordered.toggleOn", PAUSE_LABEL, "items.recurring.toggleOff"].map((l) => html.indexOf(`aria-label="${l}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});

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

describe("the list page hands the pause to every grocery row", () => {
  const page = readFileSync(resolve(__dirname, "../../app/(app)/list/[id]/page.tsx"), "utf8");
  const sortable = readFileSync(resolve(__dirname, "../../components/SortableItem.tsx"), "utf8");

  it("in the grouped (categorized) list", () => {
    expect(page).toMatch(/onPause=\{handlePause\}/);
  });

  it("in the plain list, for grocery lists only", () => {
    expect(page).toMatch(/onPause=\{listType === "grocery" \? handlePause : undefined\}/);
  });

  it("SortableItem passes it to the row", () => {
    expect(sortable).toMatch(/onPause=\{onPause\}/);
  });
});
