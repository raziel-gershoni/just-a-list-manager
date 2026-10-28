import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: { table: string; op: string; values?: unknown; filters: string[] }[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({
  verifyUserAuth: async () => ({ success: true, userId: "u1" }),
  verifyListPermission: async () => ({ allowed: true, role: "owner" }),
}));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { POST } from "@/app/api/lists/[id]/items/unmark-completed/route";

const params = { params: Promise.resolve({ id: "L" }) };
const req = () => new NextRequest("https://app.test/api/lists/L/items/unmark-completed", { method: "POST" });
function use(resolve: (c: FakeCall) => FakeResult) {
  h.fake = fakeSupabase(resolve) as typeof h.fake;
}

describe("POST /api/lists/[id]/items/unmark-completed", () => {
  it("flips completed items back with a single update and does not read the lists table", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: [{ id: "a" }, { id: "b" }], error: null }
      : { data: { type: "regular" }, error: null });

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 2, unmarkedIds: ["a", "b"] });
    expect(h.fake.calls.map((c) => `${c.table}:${c.op}`)).toEqual(["items:update"]);
    const [update] = h.fake.calls;
    expect(update.values).toEqual({ completed: false, completed_at: null });
    expect([...update.filters].sort()).toEqual(
      ["eq:completed=true", "eq:list_id=L", "is:deleted_at=null", "select:id"].sort()
    );
  });

  it("no longer special-cases a list whose stored type is still 'reminders' (no 400)", async () => {
    use((c) => c.table === "items" && c.op === "update"
      ? { data: [{ id: "a" }], error: null }
      : { data: { type: "reminders" }, error: null });

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unmarked: 1, unmarkedIds: ["a"] });
  });
});
