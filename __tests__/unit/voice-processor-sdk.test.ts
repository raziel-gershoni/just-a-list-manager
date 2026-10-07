import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real @google/genai client runs here; only the network (global fetch) is faked.
// This pins what actually goes over the wire, which the mocked-client tests can't see.
vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ GEMINI_API_KEY: "test-gemini-key" }),
}));

import { GeminiVoiceProcessor } from "@/src/services/voice-processor";

const AUDIO = Buffer.from("fake-ogg-bytes");

function geminiOk(items: unknown[]) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify({ items }) }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 40, totalTokenCount: 640 },
      modelVersion: "gemini-3.8-flash",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function gemini503() {
  return new Response(
    JSON.stringify({
      error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" },
    }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run() {
  return new GeminiVoiceProcessor().process(AUDIO, ["Groceries"], "Asia/Jerusalem", "2026-10-07T18:00:00.000Z");
}

describe("GeminiVoiceProcessor over the real SDK", () => {
  it("sends the model, JSON schema, LOW thinking and inline audio in the REST body", async () => {
    fetchMock.mockResolvedValueOnce(geminiOk([{ text: "milk", action: "add", targetList: "Groceries" }]));

    const result = await run();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect(String(url)).toContain("models/gemini-3.8-flash:generateContent");
    const body = JSON.parse(init.body);
    const gc = body.generationConfig;
    expect(gc.responseMimeType).toBe("application/json");
    // The SDK must forward the schema; it silently drops responseFormat on this API.
    expect(gc.responseJsonSchema.properties.items.items.properties.action.enum).toEqual(["add", "remove"]);
    expect(gc).not.toHaveProperty("responseSchema");
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(body.contents[0].parts).toContainEqual({
      inlineData: { mimeType: "audio/ogg", data: AUDIO.toString("base64") },
    });
    expect(result.items).toEqual([
      { text: "milk", action: "add", targetList: "Groceries", remind_at: null, recurrence: null },
    ]);
  });

  it("retries once after a 503 and returns the second attempt's items", async () => {
    fetchMock
      .mockResolvedValueOnce(gemini503())
      .mockResolvedValueOnce(geminiOk([{ text: "eggs", action: "add", targetList: "Groceries" }]));

    const result = await run();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items.map((i) => i.text)).toEqual(["eggs"]);
  });

  it("gives up after the second 503, so retries stay inside the 60s voice lock", async () => {
    fetchMock.mockImplementation(async () => gemini503());

    const result = await run();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ items: [] });
    expect(console.error).toHaveBeenCalledWith(
      "[VoiceProcessor] Gemini error:",
      expect.objectContaining({ status: 503 }),
      expect.anything()
    );
  });
});
