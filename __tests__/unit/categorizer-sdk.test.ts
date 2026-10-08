import { describe, it, expect, vi, afterEach } from "vitest";

// The real @google/genai client runs here; only the network (global fetch) is faked.
// This pins what actually goes over the wire, which the mocked-client tests can't see.
vi.mock("@/src/lib/env", () => ({ serverEnv: () => ({ GEMINI_API_KEY: "test-key" }) }));
import { GeminiCategorizer } from "@/src/services/categorizer";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GeminiCategorizer over the real SDK", () => {
  it("sends the schema and LOW thinking in the REST body and parses the reply", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify({ newCategories: [], assignments: [{ i: 0, category: "c1" }] }) }] },
        finishReason: "STOP", index: 0,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GeminiCategorizer().categorize({
      categories: [{ key: "c1", name: "Dairy" }], items: [{ i: 0, text: "milk" }], allowNew: true, maxNew: 19,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(String(url)).toContain("models/gemini-3.8-flash:generateContent");
    const gc = JSON.parse(init.body).generationConfig;
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(gc.responseJsonSchema.properties.assignments.type).toBe("array");
    expect(out).toEqual({ newCategories: [], assignments: [{ i: 0, category: "c1" }] });
  });
});
