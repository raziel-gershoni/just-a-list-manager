/**
 * Voice Processor — abstracts voice-to-structured-data processing.
 * Current implementation: Gemini 3 Flash multimodal (audio → JSON).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

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

export class GeminiVoiceProcessor implements VoiceProcessor {
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  }

  async process(audio: Buffer, listNames: string[]): Promise<VoiceResult> {
    const model = this.genAI.getGenerativeModel({
      model: "gemini-3-flash",
    });

    const audioBase64 = audio.toString("base64");
    const listNamesStr = listNames.join(", ");

    const prompt = `You are a shopping/task list assistant. The user's lists are: [${listNamesStr}].

Listen to the audio and extract items the user wants to add or remove from their lists.

Return ONLY valid JSON matching this schema:
{
  "items": [
    {
      "text": "item name",
      "action": "add" or "remove",
      "targetList": "list name or null"
    }
  ]
}

Rules:
- If the user names a list, use that exact name from the available lists
- If the user doesn't name a list, assign the most contextually appropriate list based on item type and list names
- If only one list exists, assign all items to it
- Handle mixed languages naturally (Hebrew, English, Russian in one message)
- Each item should be a separate entry
- Return JSON only, no explanation or markdown`;

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

      const responseText = result.response.text();
      return this.parseResponse(responseText);
    } catch (error) {
      console.error("[VoiceProcessor] Gemini error:", error);

      // Retry once with stricter prompt
      try {
        const retryResult = await model.generateContent([
          {
            text: `${prompt}\n\nIMPORTANT: You MUST return raw JSON only. No markdown, no code fences, no explanation.`,
          },
          {
            inlineData: {
              mimeType: "audio/ogg",
              data: audioBase64,
            },
          },
        ]);

        const retryText = retryResult.response.text();
        return this.parseResponse(retryText);
      } catch {
        return { items: [] };
      }
    }
  }

  private parseResponse(text: string): VoiceResult {
    // Try direct parse
    try {
      const parsed = JSON.parse(text);
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed as VoiceResult;
      }
    } catch {
      // Try stripping markdown code fences
    }

    try {
      const stripped = text.replace(/```json?\n?([\s\S]*?)```/g, "$1").trim();
      const parsed = JSON.parse(stripped);
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed as VoiceResult;
      }
    } catch {
      // Give up
    }

    console.error("[VoiceProcessor] Failed to parse response:", text);
    return { items: [] };
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
