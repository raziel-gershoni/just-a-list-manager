import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FinishReason, ThinkingLevel } from "@google/genai";

// Shared with the hoisted vi.mock factories below.
const h = vi.hoisted(() => ({ generateContent: vi.fn(), ctorOptions: [] as unknown[] }));

// Keep the real enums and ApiError; replace only the client so nothing reaches the network.
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent: h.generateContent };
    constructor(options: unknown) { h.ctorOptions.push(options); }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});
vi.mock("@/src/lib/env", () => ({ serverEnv: () => ({ GEMINI_API_KEY: "test-key" }) }));

import { GeminiCategorizer, parseCategorization, type CategorizeInput } from "@/src/services/categorizer";

const ok = (payload: unknown) => ({
  text: JSON.stringify(payload),
  candidates: [{ finishReason: FinishReason.STOP }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
});

const INPUT: CategorizeInput = {
  categories: [{ key: "c1", name: "Produce" }, { key: "c2", name: "Dairy" }],
  items: [{ i: 0, text: "חלב" }, { i: 1, text: "Мыло" }, { i: 2, text: "bananas" }],
  allowNew: true,
  maxNew: 18,
};

beforeEach(() => {
  h.generateContent.mockReset();
  h.ctorOptions.length = 0;
  // Any code path that bypasses the mock must not reach Google.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GeminiCategorizer.categorize request", () => {
  it("calls gemini-3.8-flash with LOW thinking, a timeout, one retry and a JSON schema", async () => {
    h.generateContent.mockResolvedValue(ok({ newCategories: [], assignments: [] }));
    await new GeminiCategorizer().categorize(INPUT);

    expect(h.ctorOptions).toEqual([{ apiKey: "test-key", vertexai: false }]);
    const req = h.generateContent.mock.calls[0][0];
    expect(req.model).toBe("gemini-3.8-flash");
    expect(req.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(req.config.httpOptions).toEqual({ timeout: 25_000, retryOptions: { attempts: 2 } });
    expect(req.config.responseMimeType).toBe("application/json");
    expect(req.config).not.toHaveProperty("responseSchema");
    expect(req.config.responseJsonSchema.required).toEqual(["newCategories", "assignments"]);
  });

  it("lists categories in walk order and every item as data", async () => {
    h.generateContent.mockResolvedValue(ok({ newCategories: [], assignments: [] }));
    await new GeminiCategorizer().categorize(INPUT);

    const prompt: string = h.generateContent.mock.calls[0][0].contents[0].text;
    expect(prompt.indexOf("c1: Produce")).toBeGreaterThan(-1);
    expect(prompt.indexOf("c1: Produce")).toBeLessThan(prompt.indexOf("c2: Dairy"));
    for (const line of ["0: חלב", "1: Мыло", "2: bananas"]) expect(prompt).toContain(line);
    expect(prompt).toMatch(/at most 18 new categories/);
  });

  it("offers no newCategories field once the list is at the cap", async () => {
    h.generateContent.mockResolvedValue(ok({ assignments: [] }));
    await new GeminiCategorizer().categorize({ ...INPUT, allowNew: false, maxNew: 0 });

    const { config, contents } = h.generateContent.mock.calls[0][0];
    expect(config.responseJsonSchema.properties).not.toHaveProperty("newCategories");
    expect(config.responseJsonSchema.required).toEqual(["assignments"]);
    expect(contents[0].text).toMatch(/Do not create categories/);
  });

  it.each([
    ["an API error", () => h.generateContent.mockRejectedValue(new Error("503"))],
    // Parseable text, so only the finish-reason check can reject it.
    ["a SAFETY finish", () => h.generateContent.mockResolvedValue({ ...ok({ assignments: [{ i: 0, category: "c1" }] }), candidates: [{ finishReason: FinishReason.SAFETY }] })],
    ["non-JSON text", () => h.generateContent.mockResolvedValue({ text: "nope", candidates: [{ finishReason: FinishReason.STOP }] })],
  ])("returns null on %s", async (_label, arrange) => {
    arrange();
    expect(await new GeminiCategorizer().categorize(INPUT)).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("parseCategorization", () => {
  it("keeps valid assignments to existing keys and to new refs", () => {
    const out = parseCategorization(JSON.stringify({
      newCategories: [{ ref: "n1", en: "Household", he: "ניקיון", ru: "Бытовое", after: "c2" }],
      assignments: [{ i: 0, category: "c2" }, { i: 1, category: "n1" }, { i: 2, category: "c1" }],
    }), INPUT);
    expect(out).toEqual({
      newCategories: [{ ref: "n1", en: "Household", he: "ניקיון", ru: "Бытовое", after: "c2" }],
      assignments: [{ i: 0, category: "c2" }, { i: 1, category: "n1" }, { i: 2, category: "c1" }],
    });
  });

  it("drops unknown keys, out-of-range or repeated indices, and unused or unnamed new categories", () => {
    const out = parseCategorization(JSON.stringify({
      newCategories: [
        { ref: "n1", en: "Used", he: "", ru: "", after: null },
        { ref: "n2", en: "Unused", he: "x", ru: "y", after: null },
        { ref: "n3", en: " ", he: "", ru: "", after: null },
        { ref: "c1", en: "Collides with an existing key", he: "", ru: "", after: null },
      ],
      assignments: [
        { i: 0, category: "c9" },
        { i: 7, category: "c1" },
        { i: 1, category: "n1" },
        { i: 1, category: "c2" },
        { i: 2, category: "n3" },
      ],
    }), INPUT);
    expect(out.assignments).toEqual([{ i: 1, category: "n1" }]);
    expect(out.newCategories).toEqual([{ ref: "n1", en: "Used", he: "Used", ru: "Used", after: null }]);
  });

  // An item assigned to "c1" must land in the existing c1, never in a second category
  // the model named c1; and one ref must not become two inserted categories.
  it("never lets a new category take an existing key or a ref already used", () => {
    const out = parseCategorization(JSON.stringify({
      newCategories: [
        { ref: "c1", en: "Collides with an existing key", he: "", ru: "", after: null },
        { ref: "n1", en: "First", he: "", ru: "", after: null },
        { ref: "n1", en: "Second", he: "", ru: "", after: null },
      ],
      assignments: [{ i: 0, category: "c1" }, { i: 1, category: "n1" }],
    }), INPUT);
    expect(out.newCategories).toEqual([{ ref: "n1", en: "First", he: "First", ru: "First", after: null }]);
    expect(out.assignments).toEqual([{ i: 0, category: "c1" }, { i: 1, category: "n1" }]);
  });

  it("lets an item's valid assignment win over an earlier invalid one", () => {
    const out = parseCategorization(JSON.stringify({
      assignments: [{ i: 0, category: "c9" }, { i: 0, category: "c2" }],
    }), INPUT);
    expect(out.assignments).toEqual([{ i: 0, category: "c2" }]);
  });

  it("trims names to 40 characters and resets an unknown 'after' to null", () => {
    const long = "x".repeat(60);
    const out = parseCategorization(JSON.stringify({
      newCategories: [{ ref: "n1", en: long, he: "  שם  ", ru: "имя", after: "c42" }],
      assignments: [{ i: 0, category: "n1" }],
    }), INPUT);
    expect(out.newCategories[0]).toEqual({ ref: "n1", en: "x".repeat(40), he: "שם", ru: "имя", after: null });
  });

  it("keeps only maxNew new categories and drops assignments to the rest", () => {
    const out = parseCategorization(JSON.stringify({
      newCategories: [
        { ref: "n1", en: "A", he: "A", ru: "A", after: null },
        { ref: "n2", en: "B", he: "B", ru: "B", after: null },
      ],
      assignments: [{ i: 0, category: "n1" }, { i: 1, category: "n2" }],
    }), { ...INPUT, maxNew: 1 });
    expect(out.newCategories.map((c) => c.ref)).toEqual(["n1"]);
    expect(out.assignments).toEqual([{ i: 0, category: "n1" }]);
  });

  // maxNew 18 isolates allowNew; with maxNew 0 the cap alone would drop the category.
  it.each([0, 18])("ignores newCategories when new ones are not allowed (maxNew %i)", (maxNew) => {
    const out = parseCategorization(JSON.stringify({
      newCategories: [{ ref: "n1", en: "A", he: "A", ru: "A", after: null }],
      assignments: [{ i: 0, category: "n1" }, { i: 1, category: "c1" }],
    }), { ...INPUT, allowNew: false, maxNew });
    expect(out).toEqual({ newCategories: [], assignments: [{ i: 1, category: "c1" }] });
  });

  it("throws when there is no assignments array", () => {
    expect(() => parseCategorization("{}", INPUT)).toThrow();
  });
});

describe("GeminiCategorizer.translateName", () => {
  it("returns the three names, filling a blank one from the input", async () => {
    h.generateContent.mockResolvedValue(ok({ en: "Pet food", he: "", ru: "Корм" }));
    expect(await new GeminiCategorizer().translateName("מזון לחיות")).toEqual({ en: "Pet food", he: "מזון לחיות", ru: "Корм" });
    const req = h.generateContent.mock.calls[0][0];
    expect(req.config.responseJsonSchema.required).toEqual(["en", "he", "ru"]);
  });

  it("returns null on failure", async () => {
    h.generateContent.mockRejectedValue(new Error("boom"));
    expect(await new GeminiCategorizer().translateName("Pets")).toBeNull();
  });
});
