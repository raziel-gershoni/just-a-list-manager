import { describe, it, expect } from "vitest";
import { overlayPending } from "@/src/sync/overlay";
import { mergeRefresh, applyCreateResult, applyRecycleResult } from "@/src/sync/merge";
import type { ItemData } from "@/src/types";

const DONE = "2026-10-29T08:00:00.000Z";

function item(over: Partial<ItemData> & { id: string }): ItemData {
  return {
    text: over.id, completed: false, completed_at: null, deleted_at: null, skipped_at: null,
    ordered_at: null, recurring: false, position: 1, created_by: null, creator_name: null,
    edited_by: null, editor_name: null, ...over,
  };
}

// pendingFields as the engine reports it: item id -> fields of its unconfirmed changes.
const pending = (map: Record<string, string[]> = {}) => (id: string) => new Set(map[id] ?? []);
const ids = (rows: ItemData[]) => rows.map((i) => i.id).sort();
const byId = (rows: ItemData[], id: string) => rows.find((i) => i.id === id);

describe("overlayPending", () => {
  it("keeps the on-screen value of each pending field and takes every other field from the server", () => {
    const local = item({ id: "a", text: "milk", completed: true, completed_at: DONE });
    const server = item({ id: "a", text: "oat milk", completed: false, completed_at: null });
    expect(overlayPending(server, local, new Set(["completed", "completed_at"]))).toMatchObject({
      text: "oat milk", completed: true, completed_at: DONE,
    });
  });

  it("returns the server row untouched when nothing is pending", () => {
    const server = item({ id: "a", text: "oat milk" });
    expect(overlayPending(server, item({ id: "a" }), new Set())).toBe(server);
  });

  it("keeps the on-screen presence for a pending delete or restore", () => {
    const local = item({ id: "a", deleted_at: null });
    const server = item({ id: "a", deleted_at: DONE });
    expect(overlayPending(server, local, new Set(["deleted"])).deleted_at).toBeNull();
  });

  it("keeps the whole on-screen row while a recycle is on its way", () => {
    const local = item({ id: "a", completed: false, created_by: "u" });
    const server = item({ id: "a", completed: true, completed_at: DONE, created_by: "x" });
    expect(overlayPending(server, local, new Set(["created"]))).toBe(local);
  });
});

describe("mergeRefresh", () => {
  it("a tick still being saved stays ticked while a collaborator's rename shows", () => {
    const a = item({ id: "a", text: "milk", completed: true, completed_at: DONE });
    const out = mergeRefresh([a], [a], [item({ id: "a", text: "oat milk" })], pending({ a: ["completed", "completed_at"] }));
    expect(byId(out, "a")).toMatchObject({ text: "oat milk", completed: true, completed_at: DONE });
  });

  it("a confirmed row takes the server's values", () => {
    const a = item({ id: "a", completed: true, completed_at: DONE });
    const out = mergeRefresh([a], [a], [item({ id: "a", completed: false })], pending());
    expect(byId(out, "a")?.completed).toBe(false);
  });

  it("a row deleted on screen, with the delete still on its way, is not brought back", () => {
    const out = mergeRefresh([], [], [item({ id: "a" })], pending({ a: ["deleted"] }));
    expect(ids(out)).toEqual([]);
  });

  it("a restored row whose restore is on its way stays although the server still has it deleted", () => {
    const a = item({ id: "a" });
    const out = mergeRefresh([a], [a], [], pending({ a: ["deleted"] }));
    expect(ids(out)).toEqual(["a"]);
  });

  it("an unsaved new item stays next to a completed item with the same text", () => {
    const temp = item({ id: "temp-1", text: "milk", _pending: true });
    const old = item({ id: "old", text: "milk", completed: true, completed_at: DONE });
    const out = mergeRefresh([temp, old], [temp, old], [old], pending({ "temp-1": ["created"] }));
    expect(ids(out)).toEqual(["old", "temp-1"]);
    expect(byId(out, "temp-1")?._pending).toBe(true);
  });

  it("a row the server no longer has leaves the screen when nothing of the user's is pending", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    expect(ids(mergeRefresh([a, b], [a, b], [a], pending()))).toEqual(["a"]);
  });

  it("a row a collaborator added appears", () => {
    const a = item({ id: "a" });
    expect(ids(mergeRefresh([a], [a], [a, item({ id: "c" })], pending()))).toEqual(["a", "c"]);
  });

  it("a row that changed on screen while the GET was out keeps the newer on-screen version", () => {
    // The tick was confirmed and its echo applied before the older snapshot came back.
    const before = item({ id: "a" });
    const now = item({ id: "a", completed: true, completed_at: DONE });
    const out = mergeRefresh([now], [before], [item({ id: "a" })], pending());
    expect(byId(out, "a")).toBe(now);
  });

  it("a create that landed while the GET was out stays, although the snapshot predates it", () => {
    const temp = item({ id: "temp-1", text: "eggs", _pending: true });
    const saved = item({ id: "r1", text: "eggs" });
    expect(ids(mergeRefresh([saved], [temp], [], pending()))).toEqual(["r1"]);
  });

  it("a row removed from the screen while the GET was out is not brought back", () => {
    const a = item({ id: "a" });
    expect(ids(mergeRefresh([], [a], [a], pending()))).toEqual([]);
  });
});

describe("applyCreateResult", () => {
  const saved = item({ id: "r1", text: "Kid's cereal", creator_name: "Dana" });

  it("turns the temp row into the saved row", () => {
    const temp = item({ id: "temp-1", text: "Kid's cereal", _pending: true });
    const out = applyCreateResult([temp], "temp-1", saved, pending());
    expect(out).toEqual([{ ...saved, creator_name: null, editor_name: null, _pending: false }]);
  });

  it("drops the temp row when the realtime INSERT already put the saved row on screen", () => {
    const temp = item({ id: "temp-1", text: "Kid’s  cereal", _pending: true });
    const out = applyCreateResult([temp, saved], "temp-1", saved, pending());
    expect(out.map((i) => i.id)).toEqual(["r1"]);
  });

  it("takes off the saved row the INSERT put on screen when the new item's delete is on its way", () => {
    const out = applyCreateResult([saved, item({ id: "b" })], "temp-1", saved, pending({ r1: ["created", "deleted"] }));
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });

  it("keeps an edit of the new item that is on its way on the saved row the INSERT put on screen", () => {
    const temp = item({ id: "temp-1", text: "milk", _pending: true });
    const echoed = item({ id: "r1", text: "mlik" });
    const out = applyCreateResult([temp, echoed], "temp-1", { ...echoed }, pending({ r1: ["text"] }));
    expect(out).toEqual([expect.objectContaining({ id: "r1", text: "milk" })]);
  });

  it("keeps a tick made on the new item that is still on its way", () => {
    const temp = item({ id: "temp-1", text: "Kid's cereal", _pending: true, completed: true, completed_at: DONE });
    const out = applyCreateResult([temp], "temp-1", saved, pending({ r1: ["completed", "completed_at"] }));
    expect(out[0]).toMatchObject({ id: "r1", completed: true, completed_at: DONE, _pending: false });
  });

  it("adds the saved row when its temp row left the screen without a delete (a reload of the list)", () => {
    const out = applyCreateResult([item({ id: "b" })], "temp-1", saved, pending());
    expect(out.map((i) => i.id).sort()).toEqual(["b", "r1"]);
    expect(byId(out, "r1")).toMatchObject({ _pending: false });
  });

  it("does not add the saved row when the new item's delete is on its way", () => {
    const out = applyCreateResult([item({ id: "b" })], "temp-1", saved, pending({ r1: ["deleted"] }));
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("applyRecycleResult", () => {
  const recycled = item({ id: "a", text: "milk", position: 6 });

  it("shows the server's row, at the position the server gave it", () => {
    const shown = item({ id: "a", text: "milk", position: 1 });
    const out = applyRecycleResult([shown, item({ id: "b" })], "a", recycled, pending());
    expect(out[0]).toMatchObject({ id: "a", position: 6 });
    expect(out[1].id).toBe("b");
  });

  it("keeps a tick made after the recycle that is still on its way", () => {
    const shown = item({ id: "a", text: "milk", position: 1, completed: true, completed_at: DONE });
    const out = applyRecycleResult([shown], "a", recycled, pending({ a: ["created", "completed", "completed_at"] }));
    expect(out[0]).toMatchObject({ position: 6, completed: true, completed_at: DONE });
  });

  it("changes nothing when the server answered with another item or nothing", () => {
    const shown = [item({ id: "a", position: 1 })];
    expect(applyRecycleResult(shown, "a", item({ id: "new" }), pending())).toBe(shown);
    expect(applyRecycleResult(shown, "a", null, pending())).toBe(shown);
  });
});
