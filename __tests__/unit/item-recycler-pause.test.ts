import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Adding a paused staple again (typed, a suggestion tap or voice) recycles it: it comes back to
// the list with no pause left on the row.
const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown; rows: ItemRow[] } }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));

import { recycleItem } from "@/src/services/item-recycler";

const ITEM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([
    itemRow({
      id: ITEM, text: "milk", recurring: true, completed: true,
      completed_at: "2026-11-12T08:00:00.000Z", paused_until: "2026-11-14T22:00:00.000Z",
    }),
  ]);
});

describe("recycleItem on a paused staple", () => {
  it("brings it back to the list and ends the pause", async () => {
    const out = await recycleItem(ITEM, "u1", "L", "milk");
    expect(out).not.toBeNull();
    expect(h.db.rows[0]).toMatchObject({ completed: false, completed_at: null, paused_until: null });
  });
});
