import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// useLocaleSync only uses useState and useCallback; React's own throw outside a render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (init: unknown) => [init, () => {}],
  useCallback: (fn: unknown) => fn,
}));
// src/lib/i18n.ts pulls in next-intl/server, which does not load in node.
vi.mock("@/src/lib/i18n", () => ({ isRtl: (lang: string) => lang === "he" }));

import { useLocaleSync } from "@/src/hooks/useLocaleSync";

const reply = (status: number) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

let html: { dir?: string; lang?: string };
let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  html = {};
  vi.stubGlobal("document", { documentElement: html });
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("setLanguage", () => {
  it("resolves true once the server saved the language", async () => {
    fetchMock.mockResolvedValue(reply(200));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("he")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith("/api/user", {
      method: "PATCH",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ language: "he" }),
    });
    expect(html).toEqual({ dir: "rtl", lang: "he" });
  });

  it("resolves false and logs when the server refused, keeping the language on screen", async () => {
    fetchMock.mockResolvedValue(reply(500));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("he")).resolves.toBe(false);

    expect(html).toEqual({ dir: "rtl", lang: "he" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[LocaleSync] Language save failed:",
      { lang: "he" },
      expect.objectContaining({ message: "Language save failed: 500" })
    );
  });

  it("resolves false and logs when the request could not be sent", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { setLanguage } = useLocaleSync({ current: "jwt" });

    await expect(setLanguage("ru")).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith("[LocaleSync] Language save failed:", { lang: "ru" }, expect.any(TypeError));
  });

  it("resolves false with a warning, and sends nothing, without a session", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setLanguage } = useLocaleSync({ current: null });

    await expect(setLanguage("he")).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[LocaleSync] No session token, language not saved:", { lang: "he" });
    expect(html).toEqual({ dir: "rtl", lang: "he" });
  });
});
