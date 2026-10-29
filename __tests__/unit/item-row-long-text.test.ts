import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactElement } from "react";

// Calls the real ItemRow as a plain function with stand-in hooks: state persists across
// calls, effects are skipped (they only focus and size the edit box in a browser).
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!(i in R.slots)) R.slots[i] = init;
    return [R.slots[i], (v: unknown) => { R.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(R.slots[i]) : v; }];
  },
  useRef: () => ({ current: null }),
  useEffect: () => {},
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import ItemRow from "@/components/ItemRow";

const LONG = "Ask the pharmacist whether the larger pack of vitamin D drops is the same strength";

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

function row(props: Partial<Parameters<typeof ItemRow>[0]> = {}) {
  R.i = 0;
  return ItemRow({ id: "i1", text: LONG, completed: false, onToggle: () => {}, onDelete: () => {}, ...props }) as El;
}
const textSpan = (el: El) => find(el, (e) => e.type === "span" && e.props.children === LONG)!;
const openEditor = (onEdit = vi.fn()) => {
  const view = row({ onEdit });
  const tapTarget = find(view, (e) => e.type === "div" && typeof e.props.onClick === "function" && !!find(e, (c) => c === textSpan(view)))!;
  (tapTarget.props.onClick as () => void)();
  return { onEdit, editor: () => find(row({ onEdit }), (e) => e.type === "textarea") };
};

beforeEach(() => { R.slots = []; });

describe("A long item is shown in full", () => {
  it("wraps onto more lines instead of cutting the text off", () => {
    const cls = String(textSpan(row()).props.className);
    expect(cls).not.toMatch(/\btruncate\b/);
    expect(cls).toMatch(/\bwrap-anywhere\b/); // a long word or link breaks too, never overflowing the row
  });

  it("keeps the checkbox on the first line of a wrapped item", () => {
    const root = row();
    expect(String(root.props.className)).toMatch(/\bitems-start\b/);
  });
});

describe("A long item is edited in full", () => {
  it("edits in a box that wraps and grows, not a one-line field", () => {
    const { editor } = openEditor();
    const box = editor()!;
    expect(box).toBeDefined();
    expect(box.props.rows).toBe(1);
    expect(box.props.maxLength).toBe(500);
    expect(box.props.value).toBe(LONG);
    expect(String(box.props.className)).toMatch(/\bresize-none\b/);
    expect(find(row(), (e) => e.type === "input")).toBeUndefined();
  });

  it("saves on Enter, also with Shift held, and never adds a line break", () => {
    const { onEdit, editor } = openEditor();
    (editor()!.props.onChange as (e: unknown) => void)({ target: { value: `${LONG} today` } });
    const preventDefault = vi.fn();
    (editor()!.props.onKeyDown as (e: unknown) => void)({ key: "Enter", shiftKey: true, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith("i1", `${LONG} today`);
    expect(editor()).toBeUndefined(); // back to the text view
  });

  it("turns pasted line breaks into spaces, since an item is one line of text", () => {
    const { onEdit, editor } = openEditor();
    (editor()!.props.onChange as (e: unknown) => void)({ target: { value: "milk\neggs \r\n bread" } });
    expect(editor()!.props.value).toBe("milk eggs bread");
    (editor()!.props.onKeyDown as (e: unknown) => void)({ key: "Enter", preventDefault: () => {} });
    expect(onEdit).toHaveBeenCalledWith("i1", "milk eggs bread");
  });

  it("Escape still cancels without saving", () => {
    const { onEdit, editor } = openEditor();
    (editor()!.props.onChange as (e: unknown) => void)({ target: { value: "changed" } });
    (editor()!.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault: () => {} });
    expect(onEdit).not.toHaveBeenCalled();
    expect(editor()).toBeUndefined();
  });
});

// Keeps the harness honest: createElement is the real one, so the tree above is React's.
void createElement;
