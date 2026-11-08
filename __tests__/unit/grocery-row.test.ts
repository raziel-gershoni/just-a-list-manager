import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";

// The grocery row (sheet mode) next to the regular row, and the page wiring that opens the item
// sheet. ItemRow is both rendered to markup and called as a plain function with stand-in hooks
// (state persists across calls, effects are skipped). Translations echo their key.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, live: false }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    // Only while a test calls ItemRow as a plain function; renderToStaticMarkup uses real hooks.
    useState: ((init: unknown) => {
      if (!R.live) return real.useState(init as never);
      const i = R.i++;
      if (!(i in R.slots)) R.slots[i] = init;
      return [R.slots[i], (v: unknown) => { R.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(R.slots[i]) : v; }];
    }) as typeof real.useState,
    useRef: ((init: unknown) => (R.live ? { current: null } : real.useRef(init as never))) as typeof real.useRef,
    useEffect: ((...a: Parameters<typeof real.useEffect>) => { if (!R.live) real.useEffect(...a); }) as typeof real.useEffect,
  };
});
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ""}${key}`,
}));

import ItemRow from "@/components/ItemRow";

type El = ReactElement<Record<string, unknown>>;
const children = (el: El): El[] => {
  const c = el.props?.children;
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter((x): x is El => !!x && typeof x === "object");
};
const find = (el: El, pred: (e: El) => boolean): El | undefined => {
  if (pred(el)) return el;
  for (const c of children(el)) { const f = find(c, pred); if (f) return f; }
  return undefined;
};

const base = () => ({
  id: "a", text: "Milk", completed: false,
  onToggle: vi.fn(), onDelete: vi.fn(), onEdit: vi.fn(), onOpenDetails: vi.fn(),
});
const html = (over: Record<string, unknown> = {}) => {
  R.live = false;
  return renderToStaticMarkup(createElement(ItemRow, { ...base(), ...over } as never));
};
const count = (s: string, needle: string) => s.split(needle).length - 1;
const row = (over: Record<string, unknown> = {}) => {
  R.i = 0;
  R.live = true;
  return ItemRow({ ...base(), ...over } as never) as El;
};
const tapDiv = (root: El) =>
  find(root, (e) => e.type === "div" && e.props.role === "button" && !!find(e, (c) => c.type === "span" && c.props.children === "Milk"))!;

beforeEach(() => { R.slots = []; R.live = false; vi.stubGlobal("window", {}); });
afterEach(() => vi.unstubAllGlobals());

describe("grocery row (sheet mode)", () => {
  it("has the circle as its only button", () => {
    expect(count(html(), "<button")).toBe(1);
  });

  it("adds the Remove-duplicates button only for a duplicate with a handler", () => {
    expect(count(html({ isDuplicate: true, onRemoveDuplicates: () => {} }), "<button")).toBe(2);
    expect(count(html({ isDuplicate: true }), "<button")).toBe(1);
  });

  it("marks On the way and Recurring by label, and only when set", () => {
    const on = html({ ordered: true, recurring: true });
    expect(on).toContain('aria-label="items.ordered.label"');
    expect(on).toContain('aria-label="items.recurring.title"');
    const off = html({ ordered: false, recurring: false });
    expect(off).not.toContain("items.ordered.label");
    expect(off).not.toContain("items.recurring.title");
  });

  it("shows the quantity at the end of the row, never shrunk away", () => {
    const withQty = html({ quantity: "2 L" });
    expect(withQty).toContain("2 L");
    const cls = withQty.match(/<span data-qty[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(cls).toMatch(/\btext-end\b/);
    expect(cls).toMatch(/\bshrink-0\b/);
    expect(html({ quantity: null })).not.toContain("data-qty");
    expect(html()).not.toContain("data-qty");
  });

  it("opens the sheet when the name is tapped, and not the inline editor", () => {
    const onOpenDetails = vi.fn();
    const r = row({ onOpenDetails });
    (tapDiv(r).props.onClick as () => void)();
    expect(onOpenDetails).toHaveBeenCalledWith("a");
    expect(find(row({ onOpenDetails }), (e) => e.type === "textarea")).toBeUndefined();
  });

  it("opens the sheet on Enter and Space from the keyboard", () => {
    const onOpenDetails = vi.fn();
    const preventDefault = vi.fn();
    const onKeyDown = tapDiv(row({ onOpenDetails })).props.onKeyDown as (e: unknown) => void;
    onKeyDown({ key: "Enter", preventDefault });
    onKeyDown({ key: " ", preventDefault });
    onKeyDown({ key: "a", preventDefault });
    expect(onOpenDetails).toHaveBeenCalledTimes(2);
    expect(onOpenDetails).toHaveBeenCalledWith("a");
  });

  it("the tappable name column is a div, so dnd-kit can still start a drag", () => {
    expect(tapDiv(row()).type).toBe("div");
  });

  it("shows a completed row's quantity read-only, with its delete button kept", () => {
    const done = html({ completed: true, onOpenDetails: undefined, quantity: "3" });
    expect(done).toContain("data-qty");
    expect(count(done, "<button")).toBe(2);
  });
});

describe("a Not available row", () => {
  it("has the circle and one Back to the list button that un-skips", () => {
    const onSkip = vi.fn();
    const markup = html({ skipped: true, onSkip });
    expect(count(markup, "<button")).toBe(2);
    expect(markup).toContain('aria-label="items.unskip"');
    R.live = true;
    R.i = 0;
    const btn = find(ItemRow({ ...base(), skipped: true, onSkip } as never) as El, (e) => e.props["aria-label"] === "items.unskip")!;
    (btn.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
    expect(onSkip).toHaveBeenCalledWith("a", false);
  });
});

describe("a regular row", () => {
  const reg = { onOpenDetails: undefined };

  it("ignores a quantity it is handed", () => {
    expect(html({ ...reg, quantity: "2 L" })).not.toContain("2 L");
  });

  it("keeps its delete button and opens the inline editor on a tap", () => {
    const markup = html(reg);
    expect(count(markup, "<button")).toBe(2);
    const r = row(reg);
    const tap = find(r, (e) => e.type === "div" && typeof e.props.onClick === "function")!;
    (tap.props.onClick as () => void)();
    expect(find(row(reg), (e) => e.type === "textarea")).toBeDefined();
  });
});

describe("sources", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

  it("use logical CSS only, so Hebrew stays right (no left/right classes)", () => {
    for (const p of ["components/ItemRow.tsx", "components/list/ItemSheet.tsx", "components/ui/SwitchRow.tsx"]) {
      expect(read(p), p).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
    }
  });

  it("the page opens the sheet from both render branches, on grocery only", () => {
    const page = read("app/(app)/list/[id]/page.tsx");
    expect(page.match(/quantity=\{item\.quantity\}/g)).toHaveLength(1);
    expect(page.match(/onOpenDetails=\{openSheet\}/g)).toHaveLength(2); // grouped + the skipped section
    expect(page).toMatch(/quantity=\{listType === "grocery" \? item\.quantity : undefined\}/);
    expect(page).toMatch(/onOpenDetails=\{listType === "grocery" \? openSheet : undefined\}/);
    expect(page).toMatch(/showQuantity=\{listType === "grocery"\}/);
  });

  it("the page renders the sheet for the live item, found by id or by its temp id", () => {
    const page = read("app/(app)/list/[id]/page.tsx");
    expect(page).toMatch(/<ItemSheet[\s\S]*item=\{sheetItem\}/);
    // A pending item's id changes from temp-… to the uuid while its sheet is open.
    expect(page).toContain("i._tempId === sheet.id");
  });
});
