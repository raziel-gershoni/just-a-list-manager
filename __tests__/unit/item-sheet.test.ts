import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// Calls the real ItemSheet as a plain function with stand-in hooks: state persists across
// calls (so a typed draft reads back), effects run at once, refs are empty.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => {
    const i = R.i++;
    if (!(i in R.slots)) R.slots[i] = init;
    return [R.slots[i], (v: unknown) => { R.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(R.slots[i]) : v; }];
  },
  useRef: () => ({ current: null }),
  useEffect: (fn: () => void) => { fn(); },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const haptic = vi.hoisted(() => vi.fn());
vi.mock("@/src/types/telegram", () => ({
  getTelegramWebApp: () => ({ HapticFeedback: { impactOccurred: haptic } }),
}));

import ItemSheet, { type ItemSheetProps } from "@/components/list/ItemSheet";
import type { ItemData } from "@/src/types/items";

type El = ReactElement<Record<string, unknown>>;

const kids = (el: El): El[] => {
  // A function component (SwitchRow) is expanded, so its role="switch" button is in the tree.
  if (typeof el.type === "function") {
    return [(el.type as (p: unknown) => El)(el.props)];
  }
  const c = el.props?.children;
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter((x): x is El => !!x && typeof x === "object");
};
const find = (el: El, pred: (e: El) => boolean): El | undefined => {
  if (pred(el)) return el;
  for (const c of kids(el)) { const f = find(c, pred); if (f) return f; }
  return undefined;
};
const text = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const el = node as El;
  if (typeof el.type === "function") return text((el.type as (p: unknown) => El)(el.props));
  return text(el.props.children);
};

const ITEM: ItemData = {
  id: "i1", text: "milk", quantity: null, completed: false, completed_at: null, deleted_at: null,
  skipped_at: null, ordered_at: null, recurring: false, position: 0, created_by: null,
  creator_name: null, edited_by: null, editor_name: null,
} as ItemData;

let calls: string[];
let props: ItemSheetProps;
const mk = (over: Partial<ItemSheetProps> = {}): ItemSheetProps => ({
  item: ITEM,
  openedSkipped: false,
  onClose: vi.fn(() => { calls.push("close"); }),
  onEdit: vi.fn(() => { calls.push("edit"); }),
  onSetQuantity: vi.fn(() => { calls.push("qty"); }),
  onSkip: vi.fn(() => { calls.push("skip"); }),
  onOrder: vi.fn(() => { calls.push("order"); }),
  onSetRecurring: vi.fn(() => { calls.push("recurring"); }),
  onPause: vi.fn(() => { calls.push("pause"); }),
  onDelete: vi.fn(() => { calls.push("delete"); }),
  ...over,
});
const render = (over: Partial<ItemSheetProps> = {}): El | null => {
  props = { ...props, ...over };
  R.i = 0;
  return ItemSheet(props) as El | null;
};
const tree = () => render()!;
const button = (label: string) =>
  find(tree(), (e) => e.type === "button" && e.props["aria-label"] === label);
const sw = (label: string) =>
  find(tree(), (e) => e.props.role === "switch" && text(e) === label);
const press = (el: El | undefined) => (el!.props.onClick as () => void)();
const nameBox = () => find(tree(), (e) => e.type === "textarea")!;
const qtyBox = () => find(tree(), (e) => e.type === "input")!;
const type = (box: () => El, value: string) =>
  (box().props.onChange as (e: unknown) => void)({ target: { value } });
const done = () => find(tree(), (e) => e.type === "button" && text(e) === "common.done");

beforeEach(() => {
  haptic.mockClear();
  R.slots = [];
  calls = [];
  props = mk();
});

describe("which controls show", () => {
  it("an active item has the On the way and Recurring switches, Not available and Delete", () => {
    expect(sw("items.ordered.title")!.props["aria-checked"]).toBe(false);
    expect(sw("items.recurring.title")!.props["aria-checked"]).toBe(false);
    expect(button("items.skip")).toBeDefined();
    expect(button("common.delete")).toBeDefined();
    expect(button("items.unskip")).toBeUndefined();
  });

  it("Not needed this week shows only on a recurring item", () => {
    expect(button("items.recurring.notThisWeek")).toBeUndefined();
    render({ item: { ...ITEM, recurring: true } });
    expect(button("items.recurring.notThisWeek")).toBeDefined();
  });

  it("an item that opened as Not available has Back to the list and Delete only", () => {
    render({ item: { ...ITEM, skipped_at: "2026-11-08T00:00:00Z" }, openedSkipped: true });
    expect(button("items.unskip")).toBeDefined();
    expect(button("common.delete")).toBeDefined();
    expect(find(tree(), (e) => e.props.role === "switch")).toBeUndefined();
    expect(button("items.skip")).toBeUndefined();
  });
});

describe("actions", () => {
  it("Not available skips, then closes", () => {
    press(button("items.skip"));
    expect(props.onSkip).toHaveBeenCalledWith("i1", true);
    expect(calls).toEqual(["skip", "close"]);
  });

  it("Back to the list un-skips, then closes", () => {
    render({ item: { ...ITEM, skipped_at: "2026-11-08T00:00:00Z" }, openedSkipped: true });
    press(button("items.unskip"));
    expect(props.onSkip).toHaveBeenCalledWith("i1", false);
    expect(calls).toEqual(["skip", "close"]);
  });

  it("Not needed this week pauses, then closes", () => {
    render({ item: { ...ITEM, recurring: true } });
    press(button("items.recurring.notThisWeek"));
    expect(props.onPause).toHaveBeenCalledWith("i1");
    expect(haptic).toHaveBeenCalledWith("light");
    expect(calls).toEqual(["pause", "close"]);
  });

  it("Delete deletes, then closes", () => {
    press(button("common.delete"));
    expect(props.onDelete).toHaveBeenCalledWith("i1");
    expect(calls).toEqual(["delete", "close"]);
  });
});

describe("switches", () => {
  it("On the way switches on without closing", () => {
    press(sw("items.ordered.title"));
    expect(props.onOrder).toHaveBeenCalledWith("i1", true);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("On the way switches off when it is on", () => {
    render({ item: { ...ITEM, ordered_at: "2026-11-08T00:00:00Z" } });
    expect(sw("items.ordered.title")!.props["aria-checked"]).toBe(true);
    press(sw("items.ordered.title"));
    expect(props.onOrder).toHaveBeenCalledWith("i1", false);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Recurring flips without closing", () => {
    press(sw("items.recurring.title"));
    expect(props.onSetRecurring).toHaveBeenCalledWith("i1", true);
    render({ item: { ...ITEM, recurring: true } });
    press(sw("items.recurring.title"));
    expect(props.onSetRecurring).toHaveBeenLastCalledWith("i1", false);
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("saving the quantity", () => {
  it("Done saves a typed quantity once, then closes", () => {
    type(qtyBox, "2 kg");
    press(done());
    expect(props.onSetQuantity).toHaveBeenCalledTimes(1);
    expect(props.onSetQuantity).toHaveBeenCalledWith("i1", "2 kg");
    expect(calls).toEqual(["qty", "close"]);
  });

  it("Done with an unchanged quantity saves nothing", () => {
    press(done());
    expect(props.onSetQuantity).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("clearing a set quantity saves null, never an empty string", () => {
    render({ item: { ...ITEM, quantity: "3" } });
    expect(qtyBox().props.value).toBe("3");
    type(qtyBox, "");
    press(done());
    expect(props.onSetQuantity).toHaveBeenCalledWith("i1", null);
  });

  it("Enter saves the quantity only, and blurs", () => {
    type(qtyBox, "5");
    type(nameBox, "oat milk");
    const blur = vi.fn();
    const preventDefault = vi.fn();
    (qtyBox().props.onKeyDown as (e: unknown) => void)({ key: "Enter", preventDefault, currentTarget: { blur } });
    expect(props.onSetQuantity).toHaveBeenCalledWith("i1", "5");
    expect(props.onEdit).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(blur).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("saving the name", () => {
  const backdrop = () => (tree().props.onClick as () => void)();

  it("a backdrop tap saves a renamed item", () => {
    type(nameBox, "oat milk");
    backdrop();
    expect(props.onEdit).toHaveBeenCalledWith("i1", "oat milk");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("a backdrop tap after emptying the name keeps the old name", () => {
    type(nameBox, "   ");
    backdrop();
    expect(props.onEdit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("a pasted line break becomes a space", () => {
    type(nameBox, "oat\nmilk");
    backdrop();
    expect(props.onEdit).toHaveBeenCalledWith("i1", "oat milk");
  });

  it("a name left as it was is not saved", () => {
    type(nameBox, "milk");
    backdrop();
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it("Enter saves the name only, and blurs", () => {
    type(nameBox, "oat milk");
    type(qtyBox, "5");
    const blur = vi.fn();
    (nameBox().props.onKeyDown as (e: unknown) => void)({ key: "Enter", preventDefault: () => {}, currentTarget: { blur } });
    expect(props.onEdit).toHaveBeenCalledWith("i1", "oat milk");
    expect(props.onSetQuantity).not.toHaveBeenCalled();
    expect(blur).toHaveBeenCalled();
  });

  it("an action saves the typed quantity before it acts", () => {
    type(qtyBox, "4");
    press(button("items.skip"));
    expect(calls).toEqual(["qty", "skip", "close"]);
  });
});

describe("the live value and closing by itself", () => {
  it("shows the live name until the user types", () => {
    render({ item: { ...ITEM, text: "milk" } });
    expect(nameBox().props.value).toBe("milk");
    render({ item: { ...ITEM, text: "milk 3%" } });
    expect(nameBox().props.value).toBe("milk 3%");
    type(nameBox, "x");
    render({ item: { ...ITEM, text: "y" } });
    expect(nameBox().props.value).toBe("x");
  });

  it("closes, saving nothing, when the item is gone", () => {
    type(nameBox, "oat milk");
    type(qtyBox, "2");
    expect(render({ item: undefined })).toBeNull();
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onEdit).not.toHaveBeenCalled();
    expect(props.onSetQuantity).not.toHaveBeenCalled();
  });

  it("closes, saving nothing, when the item was deleted elsewhere", () => {
    type(qtyBox, "2");
    expect(render({ item: { ...ITEM, deleted_at: "2026-11-08T00:00:00Z" } })).toBeNull();
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onSetQuantity).not.toHaveBeenCalled();
  });

  it("another device completing the item still saves a typed quantity, then closes", () => {
    type(qtyBox, "3 packs");
    expect(render({ item: { ...ITEM, completed: true } })).toBeNull();
    expect(props.onSetQuantity).toHaveBeenCalledWith("i1", "3 packs");
    expect(calls.slice(0, 2)).toEqual(["qty", "close"]);
  });

  it("closes when the item moves to Not available elsewhere", () => {
    render({ item: { ...ITEM, skipped_at: "2026-11-08T00:00:00Z" } });
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("layout", () => {
  it("the panel scrolls, so the keyboard cannot cover Done", () => {
    const panel = find(tree(), (e) => e.props.role === "dialog")!;
    expect(String(panel.props.className)).toContain("max-h-[90dvh]");
    expect(String(panel.props.className)).toContain("overflow-y-auto");
  });

  it("both inputs are at least 16px, so iOS does not zoom", () => {
    for (const box of [nameBox(), qtyBox()]) {
      expect(String(box.props.className)).toMatch(/(^|\s)(text-base|text-\[17px\])(\s|$)/);
    }
  });
});
