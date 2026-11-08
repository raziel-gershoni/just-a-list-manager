import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const h = vi.hoisted(() => ({
  fake: null as unknown as { client: unknown; calls: FakeCall[] },
}));
vi.mock("@/src/lib/rate-limit", () => ({ apiRateLimiter: {} }));
vi.mock("@/src/lib/api-auth", () => ({ verifyUserAuth: async () => ({ success: true, userId: "u1" }) }));
vi.mock("@/src/lib/supabase", () => ({ createServerClient: () => h.fake.client }));

import { GET } from "@/app/api/lists/route";

const OWNED = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e02";
const SHARED = "0b8f6c1e-2f4a-4c3b-9d1e-5a6b7c8d9e03";
const row = (id: string, owner: string) => ({
  id, name: "L", owner_id: owner, created_at: "2026-01-01", updated_at: "2026-01-01",
  type: "grocery", icon: null, color: null, categories_enabled: false,
});

// The owned read answers one row, the collaborator read one row (so the shared-lists read runs).
function use() {
  h.fake = fakeSupabase((c: FakeCall): FakeResult => {
    if (c.table === "lists" && c.filters.some((f) => f.startsWith("eq:owner_id"))) return { data: [row(OWNED, "u1")], error: null };
    if (c.table === "lists") return { data: [row(SHARED, "u2")], error: null };
    if (c.table === "collaborators" && c.cols === "list_id, permission") return { data: [{ list_id: SHARED, permission: "edit" }], error: null };
    return { data: [], error: null };
  });
}

describe("GET /api/lists carries the categories switch", () => {
  it("selects categories_enabled in both lists reads and returns it on each row", async () => {
    use();
    const res = await GET(new NextRequest("https://app.test/api/lists"));
    expect(res.status).toBe(200);
    const reads = h.fake.calls.filter((c) => c.table === "lists" && c.op === "select");
    expect(reads).toHaveLength(2);
    for (const r of reads) expect(r.cols).toContain("categories_enabled");
    const body = (await res.json()) as { id: string; categories_enabled: boolean }[];
    expect(body).toHaveLength(2);
    for (const l of body) expect(l.categories_enabled).toBe(false);
  });
});
