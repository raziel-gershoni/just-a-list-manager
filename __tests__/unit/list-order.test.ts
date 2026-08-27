import { describe, it, expect } from "vitest";
import {
  sortListsByUserOrder,
  buildListOrderRows,
  type OrderableList,
} from "@/src/utils/list-order";

const ME = "user-me";
const OTHER = "user-other";

// Full-shape factory so fixtures stay valid if OrderableList grows.
function makeList(overrides: Partial<OrderableList> = {}): OrderableList {
  return {
    id: "list-1",
    owner_id: ME,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ids = (lists: OrderableList[]) => lists.map((l) => l.id);

describe("sortListsByUserOrder", () => {
  it("sorts unpositioned lists above positioned ones", () => {
    const lists = [makeList({ id: "positioned" }), makeList({ id: "fresh" })];
    const positions = new Map([["positioned", 5]]);

    expect(ids(sortListsByUserOrder(lists, positions, ME))).toEqual([
      "fresh",
      "positioned",
    ]);
  });

  it("sorts positioned lists by position descending (highest first)", () => {
    const lists = [
      makeList({ id: "low" }),
      makeList({ id: "high" }),
      makeList({ id: "mid" }),
    ];
    const positions = new Map([
      ["low", 1],
      ["mid", 2],
      ["high", 3],
    ]);

    expect(ids(sortListsByUserOrder(lists, positions, ME))).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("puts owned lists before shared ones among unpositioned lists", () => {
    const lists = [
      makeList({
        id: "shared",
        owner_id: OTHER,
        updated_at: "2026-05-01T00:00:00.000Z",
      }),
      makeList({
        id: "owned",
        owner_id: ME,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "owned",
      "shared",
    ]);
  });

  it("breaks ties among equally-owned unpositioned lists by updated_at descending", () => {
    const lists = [
      makeList({ id: "older", updated_at: "2026-01-01T00:00:00.000Z" }),
      makeList({ id: "newer", updated_at: "2026-06-01T00:00:00.000Z" }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "newer",
      "older",
    ]);
  });

  // Regression guard: a user who has never dragged must see exactly the
  // ordering GET /api/lists produced before this feature existed —
  // all owned lists (newest-updated first), then all shared lists.
  it("reproduces the pre-feature ordering when no positions exist", () => {
    const lists = [
      makeList({
        id: "shared-new",
        owner_id: OTHER,
        updated_at: "2026-07-01T00:00:00.000Z",
      }),
      makeList({
        id: "owned-old",
        owner_id: ME,
        updated_at: "2026-02-01T00:00:00.000Z",
      }),
      makeList({
        id: "shared-old",
        owner_id: OTHER,
        updated_at: "2026-03-01T00:00:00.000Z",
      }),
      makeList({
        id: "owned-new",
        owner_id: ME,
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
    ];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual([
      "owned-new",
      "owned-old",
      "shared-new",
      "shared-old",
    ]);
  });

  // Delete a list, reorder the rest, then undo the delete: the restored row
  // keeps a position the renumbering has since reused, so two lists can share
  // one. Resolve that with the normal rules, not an arbitrary uuid compare.
  it("breaks a shared position by owned-first, then updated_at descending", () => {
    const lists = [
      makeList({
        id: "shared-restored",
        owner_id: OTHER,
        updated_at: "2026-09-01T00:00:00.000Z",
      }),
      makeList({
        id: "owned",
        owner_id: ME,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const positions = new Map([
      ["shared-restored", 2],
      ["owned", 2],
    ]);

    expect(ids(sortListsByUserOrder(lists, positions, ME))).toEqual([
      "owned",
      "shared-restored",
    ]);
  });

  it("keeps a valid total order when positions collide", () => {
    // An inconsistent comparator makes Array.sort's output undefined, so
    // check antisymmetry across every pair.
    const lists = [
      makeList({ id: "a", owner_id: ME, updated_at: "2026-03-01T00:00:00.000Z" }),
      makeList({ id: "b", owner_id: OTHER, updated_at: "2026-03-01T00:00:00.000Z" }),
      makeList({ id: "c", owner_id: ME, updated_at: "2026-05-01T00:00:00.000Z" }),
      makeList({ id: "d", owner_id: OTHER, updated_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const positions = new Map([
      ["a", 2],
      ["b", 2],
      ["c", 1],
    ]);

    const forward = ids(sortListsByUserOrder(lists, positions, ME));
    const reversed = ids(sortListsByUserOrder([...lists].reverse(), positions, ME));

    expect(reversed).toEqual(forward);
  });

  it("is deterministic for exact ties by falling back to id", () => {
    const lists = [makeList({ id: "b" }), makeList({ id: "a" })];

    expect(ids(sortListsByUserOrder(lists, new Map(), ME))).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const lists = [makeList({ id: "b" }), makeList({ id: "a" })];
    const before = ids(lists);

    sortListsByUserOrder(lists, new Map(), ME);

    expect(ids(lists)).toEqual(before);
  });
});

describe("buildListOrderRows", () => {
  it("gives the first id the highest position and the last id 1", () => {
    const rows = buildListOrderRows(ME, ["top", "middle", "bottom"]);

    expect(rows).toEqual([
      { user_id: ME, list_id: "top", position: 3 },
      { user_id: ME, list_id: "middle", position: 2 },
      { user_id: ME, list_id: "bottom", position: 1 },
    ]);
  });

  it("returns an empty array for no ids", () => {
    expect(buildListOrderRows(ME, [])).toEqual([]);
  });
});
