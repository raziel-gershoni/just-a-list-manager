import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items PATCH over an in-memory items table; auth, the rate limiter and the
// categorizer are faked. "Not needed this week" parks a recurring staple until the week the
// tapper's phone is in ends; every way out of that state ends the pause.
const h = vi.hoisted(() => ({
  db: null as unknown as { client: unknown; calls: { op: string }[]; rows: ItemRow[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.db.client }));
vi.mock("@/src/services/categorize-list", () => ({ categorizeList: async () => {} }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

import { PATCH } from "@/app/api/lists/[id]/items/route";

const ITEM = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK_END = iso(Date.parse("2026-11-14T22:00:00.000Z"));
const params = { params: Promise.resolve({ id: "L" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: ITEM, ...body }),
    }),
    params
  );
const row = () => h.db.rows[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk", recurring: true, ordered_at: iso(NOW - DAY) })]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PATCH pausedUntil (Not needed this week)", () => {
  it("parks the staple until its week ends and takes it off On the way", async () => {
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW - 5 * MIN) });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      completed: true,
      completed_at: iso(NOW - 5 * MIN),
      paused_until: WEEK_END,
      skipped_at: null,
      ordered_at: null,
    });
  });

  it("also takes it out of Not available", async () => {
    h.db.rows[0].ordered_at = null;
    h.db.rows[0].skipped_at = iso(NOW - HOUR);
    await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(row().skipped_at).toBe(null);
  });

  it("moves a pause end before the tap up to the tap", async () => {
    await patch({ pausedUntil: iso(NOW - 2 * HOUR), at: iso(NOW - MIN) });
    expect(row().paused_until).toBe(iso(NOW - MIN));
  });

  it("caps a pause end more than a week and an hour away (a wrong device clock)", async () => {
    await patch({ pausedUntil: iso(NOW + 30 * DAY), at: iso(NOW) });
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY + HOUR));
  });

  it("keeps a pause end exactly a week and an hour away (the week the clocks go back)", async () => {
    await patch({ pausedUntil: iso(NOW + 7 * DAY + HOUR), at: iso(NOW) });
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY + HOUR));
  });

  it("pauses for a week after the tap when the end does not parse, never a 400", async () => {
    const res = await patch({ pausedUntil: "next sunday", at: iso(NOW) });
    expect(res.status).toBe(200);
    expect(row().paused_until).toBe(iso(NOW + 7 * DAY));
    expect(console.warn).toHaveBeenCalled();
  });

  it("writes nothing to an item that no longer repeats (a collaborator stopped it first)", async () => {
    h.db.rows[0].recurring = false;
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(res.status).toBe(404);
    expect(row()).toMatchObject({ completed: false, completed_at: null, paused_until: null });
  });

  it("never pauses a deleted item", async () => {
    h.db.rows[0].deleted_at = iso(NOW - HOUR);
    const res = await patch({ pausedUntil: WEEK_END, at: iso(NOW) });
    expect(res.status).toBe(404);
    expect(row().paused_until).toBe(null);
  });
});

describe("every way out of a pause ends it", () => {
  beforeEach(() => {
    Object.assign(h.db.rows[0], { completed: true, completed_at: iso(NOW - DAY), paused_until: WEEK_END, ordered_at: null });
  });

  it.each([
    ["untick", { completed: false }],
    ["tick (a plain buy parks it for the usual four hours)", { completed: true }],
    ["bring it back now", { restoreRecurring: true }],
    ["stop repeating", { recurring: false }],
  ])("%s", async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(row().paused_until).toBe(null);
  });

  it("turning repeat on again leaves the pause alone", async () => {
    await patch({ recurring: true });
    expect(row().paused_until).toBe(WEEK_END);
  });
});
