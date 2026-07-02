import { describe, it, expect } from "vitest";
import { buildRecipientList, type JoinedUser } from "@/src/lib/list-notify";

const u = (id: string, tg: number | null, lang: string | null = "en"): JoinedUser => ({
  id,
  telegram_id: tg,
  language: lang,
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
