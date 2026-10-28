/**
 * Voice Processor — abstracts voice-to-structured-data processing.
 * Current implementation: Gemini 3.8 Flash multimodal (audio → JSON) via @google/genai.
 */

import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
} from "@google/genai";
import { serverEnv } from "@/src/lib/env";

/** Pinned stable model id. Rolling back is a one-line change. */
const VOICE_MODEL = "gemini-3.8-flash";

/** Abort a hung attempt so the user gets voice.error instead of no reply at all. */
const VOICE_TIMEOUT_MS = 25_000;

/**
 * One retry on 408/429/5xx (the SDK's default codes), after about 1–2 s. 3.8 Flash returns
 * 503 "high demand" at times. Two attempts at most keep the worst case (2 × 25 s plus the
 * delay) inside the 60 s voice lock in src/utils/redis-lock.ts.
 */
const VOICE_ATTEMPTS = 2;

// JSON Schema via responseJsonSchema: the API reference marks responseSchema deprecated,
// and @google/genai 2.27 drops its replacement, responseFormat, on the Gemini API.
const voiceResultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          action: { type: "string", enum: ["add", "remove"] },
          targetList: { type: ["string", "null"] },
        },
        required: ["text", "action"],
      },
    },
  },
  required: ["items"],
};

export interface VoiceItem {
  text: string;
  action: "add" | "remove";
  targetList: string | null;
}

export interface VoiceResult {
  items: VoiceItem[];
}

export interface VoiceProcessor {
  process(audio: Buffer, listNames: string[]): Promise<VoiceResult>;
}

/**
 * Parse the model's JSON and drop anything the handler must not act on. Structured output
 * guarantees the shape, not the values: an action other than "add" would otherwise reach
 * the handler's remove branch. Only text, action and targetList are copied, so a stray
 * field from an older schema never reaches the handler. Throws when the text is not
 * JSON or has no items array.
 */
function parseVoiceResult(text: string): VoiceResult {
  const rawItems = (JSON.parse(text) as { items?: unknown } | null)?.items;
  if (!Array.isArray(rawItems)) {
    throw new Error("Gemini response has no items array");
  }

  const items: VoiceItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    if (r.action !== "add" && r.action !== "remove") continue;

    items.push({
      text: r.text.trim(),
      action: r.action,
      targetList: typeof r.targetList === "string" && r.targetList.trim() ? r.targetList : null,
    });
  }

  if (items.length < rawItems.length) {
    console.warn(`[VoiceProcessor] dropped ${rawItems.length - items.length} invalid item(s)`);
  }
  return { items };
}

export class GeminiVoiceProcessor implements VoiceProcessor {
  private ai: GoogleGenAI;

  constructor() {
    // vertexai: false pins the Gemini Developer API even if GOOGLE_GENAI_USE_VERTEXAI is set.
    this.ai = new GoogleGenAI({ apiKey: serverEnv().GEMINI_API_KEY, vertexai: false });
  }

  async process(audio: Buffer, listNames: string[]): Promise<VoiceResult> {
    const listNamesStr = listNames.join(", ");

    const prompt = `Shopping/task list assistant. Lists: [${listNamesStr}].

Extract items to add/remove. Rules:
- Match list names from available lists, or infer from context. One list = assign all to it.
- Mixed languages OK (Hebrew, English, Russian).
- Each item = separate entry. Item text = the item itself: drop command words in any language (e.g. "remind me to", "add", "put on the list"). Keep any time or date words: "remind me to call mom at 9" -> "call mom at 9".`;

    const config: GenerateContentConfig = {
      responseMimeType: "application/json",
      responseJsonSchema: voiceResultSchema,
      // 3.8 Flash defaults to MEDIUM and rejects MINIMAL. LOW suits a short extraction.
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      httpOptions: { timeout: VOICE_TIMEOUT_MS, retryOptions: { attempts: VOICE_ATTEMPTS } },
    };

    try {
      const response = await this.ai.models.generateContent({
        model: VOICE_MODEL,
        contents: [
          { text: prompt },
          { inlineData: { mimeType: "audio/ogg", data: audio.toString("base64") } },
        ],
        config,
      });

      const finishReason = response.candidates?.[0]?.finishReason;
      const usage = response.usageMetadata;
      console.info("[VoiceProcessor] usage", {
        model: VOICE_MODEL,
        finishReason,
        promptTokens: usage?.promptTokenCount,
        thoughtsTokens: usage?.thoughtsTokenCount,
        outputTokens: usage?.candidatesTokenCount,
      });

      // Unlike the legacy SDK's text(), response.text never throws on a SAFETY or
      // LANGUAGE finish, so check the finish reason explicitly.
      const text = response.text;
      if (!text || (finishReason && finishReason !== FinishReason.STOP)) {
        console.error("[VoiceProcessor] Gemini returned no usable output", {
          model: VOICE_MODEL,
          finishReason,
          blockReason: response.promptFeedback?.blockReason,
        });
        return { items: [] };
      }

      return parseVoiceResult(text);
    } catch (error) {
      console.error(
        "[VoiceProcessor] Gemini error:",
        { model: VOICE_MODEL, status: error instanceof ApiError ? error.status : undefined },
        error
      );
      return { items: [] };
    }
  }
}

// Default singleton
let _processor: VoiceProcessor | null = null;
export function getVoiceProcessor(): VoiceProcessor {
  if (!_processor) {
    _processor = new GeminiVoiceProcessor();
  }
  return _processor;
}
