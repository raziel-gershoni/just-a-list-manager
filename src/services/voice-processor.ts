/**
 * Voice Processor — abstracts voice-to-structured-data processing.
 * Current implementation: Gemini 3 Flash Preview multimodal (audio → JSON).
 */

import {
  GoogleGenerativeAI,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";
import { serverEnv } from "@/src/lib/env";

const voiceResultSchema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    items: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text: { type: SchemaType.STRING },
          action: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["add", "remove"],
          },
          targetList: { type: SchemaType.STRING, nullable: true },
          remind_at: { type: SchemaType.STRING, nullable: true },
          recurrence: { type: SchemaType.STRING, nullable: true },
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
  remind_at?: string | null;
  recurrence?: string | null;
}

export interface VoiceResult {
  items: VoiceItem[];
}

export interface VoiceProcessor {
  process(audio: Buffer, listNames: string[], timezone: string, currentTime: string): Promise<VoiceResult>;
}

export class GeminiVoiceProcessor implements VoiceProcessor {
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(serverEnv().GEMINI_API_KEY);
  }

  async process(audio: Buffer, listNames: string[], timezone: string, currentTime: string): Promise<VoiceResult> {
    const model = this.genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: voiceResultSchema,
      },
    });

    const audioBase64 = audio.toString("base64");
    const listNamesStr = listNames.join(", ");

    const prompt = `Shopping/task list assistant. Lists: [${listNamesStr}]. Now: ${currentTime}, TZ: ${timezone}.

Extract items to add/remove. Rules:
- Match list names from available lists, or infer from context. One list = assign all to it.
- Mixed languages OK (Hebrew, English, Russian).
- Each item = separate entry. Item text = just the task name, no time words.
- ONLY if user says a time/schedule: set remind_at (ISO 8601 with offset) and optionally recurrence (daily/weekly/monthly). Otherwise leave them null.`;

    try {
      const result = await model.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: "audio/ogg",
            data: audioBase64,
          },
        },
      ]);

      return JSON.parse(result.response.text()) as VoiceResult;
    } catch (error) {
      console.error("[VoiceProcessor] Gemini error:", error);
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
