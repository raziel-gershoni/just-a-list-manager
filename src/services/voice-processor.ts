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

    const prompt = `You are a shopping/task list assistant. The user's lists are: [${listNamesStr}].
Current time: ${currentTime}
User timezone: ${timezone}

Listen to the audio and extract items the user wants to add or remove from their lists.

Rules:
- If the user names a list, use that exact name from the available lists
- If the user doesn't name a list, assign the most contextually appropriate list based on item type and list names
- If only one list exists, assign all items to it
- Handle mixed languages naturally (Hebrew, English, Russian in one message)
- Each item should be a separate entry
- If the user mentions a time, date, or schedule (e.g., "tomorrow at 9am", "in 2 hours", "daily at 8pm", "מחר בתשע", "завтра в 9"), set remind_at as ISO 8601 datetime with timezone offset
- If the user mentions recurrence ("daily", "weekly", "monthly", "כל יום", "каждый день"), set recurrence accordingly
- remind_at and recurrence are optional — only set them if the user explicitly mentions a time or schedule
- For the item text, extract just the task/item name without the time/schedule part`;

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
