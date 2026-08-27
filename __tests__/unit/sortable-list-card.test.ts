import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("SortableListCard drag activation", () => {
  // Guards a silent-break bug that shipped once already: long-pressing a list
  // card did nothing at all.
  //
  // On pointerdown, @dnd-kit's PointerSensor runs:
  //     const { preventActivation = defaults.preventActivation } = options ?? {};
  //     if (preventActivation?.(event, source)) return;   // silent bail
  // Configuring the sensor with activationConstraints does NOT replace
  // preventActivation, and its default ends in isInteractiveElement(target),
  // which is `element.closest("... button:not([disabled]) ...")` — an ANCESTOR
  // lookup. ListCard's root is a <button>, so every pointerdown anywhere inside
  // a card resolves to it and the drag never starts.
  //
  // preventActivation's only escape hatch runs before that check:
  //     if (source.handle?.contains(target)) return false;
  // so the sortable must designate a handle covering the card. Setting it to
  // the same wrapper that carries `ref` is free — the sensor binds its
  // pointerdown listener to `source.handle ?? source.element` either way.
  it("passes handleRef, or @dnd-kit refuses to start the drag", () => {
    const sortable = read("components/SortableListCard.tsx");

    expect(
      sortable.includes("handleRef"),
      "SortableListCard must attach handleRef. ListCard's root is a <button>, " +
        "and @dnd-kit's default preventActivation blocks a drag whose " +
        "pointerdown target has an interactive ancestor unless source.handle " +
        "contains that target."
    ).toBe(true);
  });
});
