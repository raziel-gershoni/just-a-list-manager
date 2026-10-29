import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeItemsTable, itemRow, type ItemRow } from "../helpers/fake-items-table";

// Runs the real items PATCH over an in-memory items table; auth, the rate limiter and the
// categorizer are faked. H19: a tick, skip or "on the way" replayed from the offline queue
// keeps the time of the tap (`at`), clamped to the last 24 hours and never in the future.
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
const NOW = Date.parse("2026-10-29T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const params = { params: Promise.resolve({ id: "L" }) };
const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("https://app.test/api/lists/L/items", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: ITEM, ...body }),
    }),
    params
  );
const row = () => h.db.rows[0];

// Each action, the body that turns it on, and the column that records when.
const ACTIONS = [
  ["tick", { completed: true }, "completed_at"],
  ["skip", { skipped: true }, "skipped_at"],
  ["on the way", { ordered: true }, "ordered_at"],
] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.db = fakeItemsTable([itemRow({ id: ITEM, text: "milk" })]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PATCH items stamps the tap time", () => {
  describe.each(ACTIONS)("%s", (_label, on, column) => {
    it("records the tap time sent in `at`, not the sync time", async () => {
      const res = await patch({ ...on, at: iso(NOW - 3 * HOUR) });
      expect(res.status).toBe(200);
      expect(row()[column]).toBe(iso(NOW - 3 * HOUR));
    });

    it("accepts a tap time with a UTC offset", async () => {
      await patch({ ...on, at: "2026-10-29T15:30:00+03:00" });
      expect(row()[column]).toBe("2026-10-29T12:30:00.000Z");
    });

    it("clamps a tap time older than 24 hours to 24 hours ago", async () => {
      await patch({ ...on, at: iso(NOW - 3 * 24 * HOUR) });
      expect(row()[column]).toBe(iso(NOW - 24 * HOUR));
    });

    it("clamps a tap time in the future (a fast device clock) to now", async () => {
      await patch({ ...on, at: iso(NOW + 2 * HOUR) });
      expect(row()[column]).toBe(iso(NOW));
    });

    it("uses the server time when no `at` is sent (an entry queued before this change)", async () => {
      await patch({ ...on });
      expect(row()[column]).toBe(iso(NOW));
    });

    it("stamps the same time on a duplicate delivery", async () => {
      await patch({ ...on, at: iso(NOW - 10 * MIN) });
      vi.setSystemTime(NOW + HOUR);
      await patch({ ...on, at: iso(NOW - 10 * MIN) });
      expect(row()[column]).toBe(iso(NOW - 10 * MIN));
    });
  });

  it("still clears completed_at on an untick that carries `at`", async () => {
    h.db.rows[0].completed = true;
    h.db.rows[0].completed_at = iso(NOW - HOUR);
    await patch({ completed: false, at: iso(NOW - 5 * MIN) });
    expect(row()).toMatchObject({ completed: false, completed_at: null });
  });

  it("ignores an `at` that does not parse and uses the server time, never a 400", async () => {
    const res = await patch({ completed: true, at: "yesterday" });
    expect(res.status).toBe(200);
    expect(row().completed_at).toBe(iso(NOW));
  });
});
