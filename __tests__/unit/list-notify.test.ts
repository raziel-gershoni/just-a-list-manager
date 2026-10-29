import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRecipientList, candidatesFromRows, resolveListRecipients, type JoinedUser } from "@/src/lib/list-notify";
import { fakeSupabase, type FakeCall, type FakeResult } from "../helpers/fake-supabase";

const u = (id: string, tg: number | null, lang: string | null = "en"): JoinedUser => ({
  id,
  telegram_id: tg,
  language: lang,
});

describe("candidatesFromRows", () => {
  it("reads the collaborator's `users` embed as a single object, not an array", () => {
    // Regression guard: Supabase returns this to-one FK embed as an object.
    // A `.users[0]` mapping would drop every collaborator to null.
    const owner = u("owner", 1);
    const collab = u("c1", 2, "he");
    expect(candidatesFromRows({ users: owner }, [{ users: collab }])).toEqual([owner, collab]);
  });

  it("tolerates a null owner embed and null collaborator embeds", () => {
    expect(candidatesFromRows(null, [{ users: null }])).toEqual([null, null]);
  });

  it("handles missing (null) collaborator rows", () => {
    const owner = u("owner", 1);
    expect(candidatesFromRows({ users: owner }, null)).toEqual([owner]);
  });
});

describe("buildRecipientList", () => {
  it("excludes the sender", () => {
    const out = buildRecipientList([u("owner", 1), u("me", 2)], "me");
    expect(out).toEqual([{ telegramId: 1, language: "en" }]);
  });

  it("drops null telegram_id and null entries", () => {
    const out = buildRecipientList([u("a", null), null, u("b", 3)], "me");
    expect(out).toEqual([{ telegramId: 3, language: "en" }]);
  });

  it("dedupes by user id (owner also a collaborator)", () => {
    const out = buildRecipientList([u("owner", 1), u("owner", 1)], "me");
    expect(out).toEqual([{ telegramId: 1, language: "en" }]);
  });

  it("falls back to en when language is null", () => {
    const out = buildRecipientList([u("a", 5, null)], "me");
    expect(out).toEqual([{ telegramId: 5, language: "en" }]);
  });

  it("preserves a non-null language", () => {
    const out = buildRecipientList([u("a", 5, "he")], "me");
    expect(out).toEqual([{ telegramId: 5, language: "he" }]);
  });
});

describe("resolveListRecipients", () => {
  // PostgREST answers .single() on zero rows with PGRST116; .maybeSingle() answers null.
  const NO_ROW = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
  const dbErr = { message: "canceling statement due to statement timeout", code: "57014" };
  const ownerRow = { owner_id: "owner", users: u("owner", 1, "he") };

  function db(opts: { owner?: unknown; ownerError?: unknown; collabs?: unknown[]; collabError?: unknown }) {
    return fakeSupabase((c: FakeCall): FakeResult => {
      if (c.table === "lists") {
        if (opts.ownerError) return { data: null, error: opts.ownerError };
        if (opts.owner == null && c.filters.includes("single")) return { data: null, error: NO_ROW };
        return { data: opts.owner ?? null, error: null };
      }
      if (c.table === "collaborators") {
        return opts.collabError ? { data: null, error: opts.collabError } : { data: opts.collabs ?? [], error: null };
      }
      return { data: null, error: null };
    }).client;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("notifies the owner and the approved collaborators, never the sender", async () => {
    const supabase = db({
      owner: ownerRow,
      collabs: [{ user_id: "me", users: u("me", 2) }, { user_id: "c1", users: u("c1", 3, "ru") }],
    });
    expect(await resolveListRecipients(supabase, "L", "me")).toEqual([
      { telegramId: 1, language: "he" },
      { telegramId: 3, language: "ru" },
    ]);
  });

  it("rejects and logs when the owner read fails, instead of silently leaving the owner out", async () => {
    await expect(resolveListRecipients(db({ ownerError: dbErr }), "L", "me")).rejects.toThrow("Recipient lookup failed");
    expect(console.error).toHaveBeenCalledWith("[ListNotify] Owner read failed:", { listId: "L" }, dbErr);
  });

  it("rejects and logs when the collaborators read fails, instead of answering 'nobody to notify'", async () => {
    await expect(resolveListRecipients(db({ owner: ownerRow, collabError: dbErr }), "L", "owner")).rejects.toThrow(
      "Recipient lookup failed"
    );
    expect(console.error).toHaveBeenCalledWith("[ListNotify] Collaborators read failed:", { listId: "L" }, dbErr);
  });

  it("resolves [] when the owner sends and the list has no collaborators", async () => {
    expect(await resolveListRecipients(db({ owner: ownerRow, collabs: [] }), "L", "owner")).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("still notifies the collaborators when the list row is gone", async () => {
    const supabase = db({ owner: null, collabs: [{ user_id: "c1", users: u("c1", 3) }] });
    expect(await resolveListRecipients(supabase, "L", "me")).toEqual([{ telegramId: 3, language: "en" }]);
    expect(console.error).not.toHaveBeenCalled();
  });
});
