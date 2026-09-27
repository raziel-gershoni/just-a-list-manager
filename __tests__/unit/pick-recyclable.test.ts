import { describe, it, expect } from "vitest";
import { pickRecyclable } from "@/src/utils/pick-recyclable";

interface Row {
  id: string;
  text: string;
}

const recyclable: Row[] = [
  { id: "aaa-1", text: "milk" },
  { id: "bbb-2", text: "milk" },
];

describe("pickRecyclable", () => {
  it("returns the match when the id is present in the server-found set", () => {
    expect(pickRecyclable(recyclable, "bbb-2")).toBe(recyclable[1]);
  });

  it("returns undefined for an id not among the server-found rows", () => {
    // This is the exploit path: an attacker-supplied uuid for a row in a
    // different list must never be forwarded to recycleItem.
    expect(pickRecyclable(recyclable, "some-other-lists-item-id")).toBeUndefined();
  });

  it("returns undefined when recycleId is undefined", () => {
    expect(pickRecyclable(recyclable, undefined)).toBeUndefined();
  });

  it("does not match by array index", () => {
    // "0" and "1" are not valid ids in this set — must not resolve to
    // recyclable[0] / recyclable[1] by falling back to index semantics.
    expect(pickRecyclable(recyclable, "0")).toBeUndefined();
    expect(pickRecyclable(recyclable, "1")).toBeUndefined();
  });

  it("does not match by id prefix", () => {
    expect(pickRecyclable(recyclable, "aaa")).toBeUndefined();
  });

  it("returns undefined when the recyclable set is empty", () => {
    expect(pickRecyclable([], "aaa-1")).toBeUndefined();
  });
});
