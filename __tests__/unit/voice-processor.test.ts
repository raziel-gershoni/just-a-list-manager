import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BlockedReason, FinishReason, ThinkingLevel } from "@google/genai";

// Shared with the hoisted vi.mock factories below.
const h = vi.hoisted(() => ({
  generateContent: vi.fn(),
  ctorOptions: [] as unknown[],
}));

// Keep the real enums and ApiError; replace only the client so nothing reaches the network.
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent: h.generateContent };
    constructor(options: unknown) {
      h.ctorOptions.push(options);
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ GEMINI_API_KEY: "test-gemini-key" }),
}));

import { GeminiVoiceProcessor } from "@/src/services/voice-processor";

const AUDIO = Buffer.from("fake-ogg-bytes");
const LISTS = ["Groceries", "קניות", "Дом"];

function okResponse(payload: unknown) {
  return {
    text: JSON.stringify(payload),
    candidates: [{ finishReason: FinishReason.STOP }],
    usageMetadata: { promptTokenCount: 600, thoughtsTokenCount: 120, candidatesTokenCount: 40 },
  };
}

async function run() {
  return new GeminiVoiceProcessor().process(AUDIO, LISTS);
}

function sentPrompt(): string {
  const { contents } = h.generateContent.mock.calls[0][0];
  return contents.find((p: { text?: string }) => typeof p.text === "string").text;
}

beforeEach(() => {
  h.generateContent.mockReset();
  h.ctorOptions.length = 0;
  // Any code path that bypasses the mock must not reach Google.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in unit tests");
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GeminiVoiceProcessor request", () => {
  it("calls gemini-3.8-flash on the Gemini Developer API with LOW thinking and a timeout", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    expect(h.ctorOptions).toEqual([{ apiKey: "test-gemini-key", vertexai: false }]);
    expect(h.generateContent).toHaveBeenCalledOnce();
    const req = h.generateContent.mock.calls[0][0];
    expect(req.model).toBe("gemini-3.8-flash");
    // 3.8 Flash rejects MINIMAL, and a thinkingBudget sent alongside a level is a 400.
    expect(req.config.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(req.config.httpOptions.timeout).toBeGreaterThan(0);
    expect(req.config.httpOptions.timeout).toBeLessThanOrEqual(60_000);
  });

  it("sends the schema as responseJsonSchema, not the deprecated responseSchema or the dropped responseFormat", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    const { config } = h.generateContent.mock.calls[0][0];
    expect(config.responseMimeType).toBe("application/json");
    expect(config).not.toHaveProperty("responseSchema");
    expect(config).not.toHaveProperty("responseFormat");
    const schema = config.responseJsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["items"]);
    const item = schema.properties.items.items;
    expect(item.properties.action).toEqual({ type: "string", enum: ["add", "remove"] });
    expect(item.required).toEqual(["text", "action"]);
  });

  it("sends the prompt as text plus the voice note as inline base64 audio/ogg", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    const { contents } = h.generateContent.mock.calls[0][0];
    const textPart = contents.find((p: { text?: string }) => typeof p.text === "string");
    const audioPart = contents.find((p: { inlineData?: unknown }) => p.inlineData);
    for (const name of LISTS) expect(textPart.text).toContain(name);
    expect(audioPart.inlineData).toEqual({ mimeType: "audio/ogg", data: AUDIO.toString("base64") });
  });

  it("offers the model only text, action and targetList, with no reminder fields", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    const item = h.generateContent.mock.calls[0][0].config.responseJsonSchema.properties.items.items;
    expect(Object.keys(item.properties).sort()).toEqual(["action", "targetList", "text"]);
    expect(item.properties).not.toHaveProperty("remind_at");
    expect(item.properties).not.toHaveProperty("recurrence");
  });

  it("tells the model to drop command words and keep time words in the item text", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    const prompt = sentPrompt();
    for (const command of ['"remind me to"', '"add"', '"put on the list"']) {
      expect(prompt).toContain(command);
    }
    expect(prompt).toMatch(/keep any time or date words/i);
    expect(prompt).toContain('"remind me to call mom at 9" -> "call mom at 9"');
    // The old rule stripped them ("no time words") so that remind_at could carry the time.
    expect(prompt).not.toMatch(/no time words/i);
    expect(prompt).not.toMatch(/remind_at|recurrence/);
  });

  it("sends no current time or time zone, since nothing reads them any more", async () => {
    h.generateContent.mockResolvedValue(okResponse({ items: [] }));
    await run();

    const prompt = sentPrompt();
    expect(prompt).not.toMatch(/Now:|TZ:/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("GeminiVoiceProcessor response handling", () => {
  it("returns valid items with only text, action and targetList", async () => {
    h.generateContent.mockResolvedValue(
      okResponse({
        items: [
          { text: "חלב", action: "add", targetList: "קניות" },
          { text: "вынести мусор в четверг", action: "add", targetList: "Дом" },
          { text: "eggs", action: "remove", targetList: null },
        ],
      })
    );

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result.items).toStrictEqual([
      { text: "חלב", action: "add", targetList: "קניות" },
      { text: "вынести мусор в четверг", action: "add", targetList: "Дом" },
      { text: "eggs", action: "remove", targetList: null },
    ]);
  });

  it("ignores a stray remind_at or recurrence and keeps the item text with its time words", async () => {
    h.generateContent.mockResolvedValue(
      okResponse({
        items: [
          { text: "call mom at 9", action: "add", targetList: "Дом", remind_at: "2026-10-08T09:00:00+03:00", recurrence: "daily" },
          { text: "pay rent tomorrow", action: "add", targetList: "Дом", remind_at: "tomorrow 9am", recurrence: "weekly" },
        ],
      })
    );

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result.items).toStrictEqual([
      { text: "call mom at 9", action: "add", targetList: "Дом" },
      { text: "pay rent tomorrow", action: "add", targetList: "Дом" },
    ]);
    // Nothing parses the field any more, so nothing warns about it either.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("drops items whose action is not exactly add/remove instead of letting them reach the remove branch", async () => {
    h.generateContent.mockResolvedValue(
      okResponse({
        items: [
          { text: "milk", action: "delete" },
          { text: "bread", action: "Add" },
          { text: "soap", action: "complete" },
          { text: "", action: "add" },
          { action: "add" },
          { text: "eggs", action: "add" },
        ],
      })
    );

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result.items.map((i) => [i.text, i.action])).toEqual([["eggs", "add"]]);
  });

  it("normalizes a missing, blank or non-string targetList to null", async () => {
    h.generateContent.mockResolvedValue(
      okResponse({
        items: [
          { text: "a", action: "add" },
          { text: "b", action: "add", targetList: "   " },
          // The handler calls targetList.toLowerCase(); a number would throw there.
          { text: "c", action: "add", targetList: 42 },
          { text: "d", action: "add", targetList: "Groceries" },
        ],
      })
    );

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.targetList)).toEqual([null, null, null, "Groceries"]);
  });

  it("logs the block reason when the prompt itself is blocked", async () => {
    h.generateContent.mockResolvedValue({
      text: undefined,
      candidates: [],
      promptFeedback: { blockReason: BlockedReason.SAFETY },
    });

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result).toEqual({ items: [] });
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: "gemini-3.8-flash", blockReason: BlockedReason.SAFETY })
    );
  });

  it.each([
    ["a SAFETY finish with text", { text: '{"items":[{"text":"x","action":"add"}]}', candidates: [{ finishReason: FinishReason.SAFETY }] }],
    ["a LANGUAGE finish with text", { text: '{"items":[{"text":"x","action":"add"}]}', candidates: [{ finishReason: FinishReason.LANGUAGE }] }],
    ["MAX_TOKENS-truncated JSON", { text: '{"items":[{"text":"x","act', candidates: [{ finishReason: FinishReason.MAX_TOKENS }] }],
    ["no text at all", { text: undefined, candidates: [] }],
    ["JSON without an items array", { text: "{}", candidates: [{ finishReason: FinishReason.STOP }] }],
    ["markdown-fenced JSON", { text: '```json\n{"items":[]}\n```', candidates: [{ finishReason: FinishReason.STOP }] }],
  ])("returns no items and logs for %s", async (_label, response) => {
    h.generateContent.mockResolvedValue(response);
    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result).toEqual({ items: [] });
    expect(console.error).toHaveBeenCalled();
  });

  it("returns no items and logs the HTTP status when the API call fails", async () => {
    const { ApiError } = await import("@google/genai");
    h.generateContent.mockRejectedValue(new ApiError({ message: "model not found", status: 404 }));

    const result = await run();
    expect(h.generateContent).toHaveBeenCalledOnce();
    expect(result).toEqual({ items: [] });
    expect(console.error).toHaveBeenCalledWith(
      "[VoiceProcessor] Gemini error:",
      expect.objectContaining({ model: "gemini-3.8-flash", status: 404 }),
      expect.anything()
    );
  });
});
