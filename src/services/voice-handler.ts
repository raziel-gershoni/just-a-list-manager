/**
 * Voice message handler — orchestrates the full voice processing pipeline.
 * Download OGG → Gemini multimodal → server-side recycling → apply mutations → receipt
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";
import { acquireVoiceLock, releaseVoiceLock } from "@/src/utils/redis-lock";
import { voiceRateLimiter } from "@/src/lib/rate-limit";
import { checkRateLimit } from "@/src/lib/rate-limit";
import { getVoiceProcessor, type VoiceItem } from "./voice-processor";
import { findFuzzyMatch, recycleItem } from "./item-recycler";

/** Escape ILIKE special characters */
function escapeIlike(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}

const MAX_VOICE_FILE_SIZE = 5 * 1024 * 1024; // 5MB

interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  language_code?: string;
}

export async function handleVoiceMessage(
  chatId: number,
  telegramUserId: number,
  voice: TgVoice,
  from: TgUser
) {
  const bot = (await import("./bot")).default;

  // Rate limit check — fail-closed to protect Gemini API
  const rateLimitResult = await checkRateLimit(
    voiceRateLimiter,
    telegramUserId,
    true
  );
  if (!rateLimitResult.success) {
    try {
      await bot.sendMessage(
        chatId,
        "You're sending voice messages too quickly. Please wait a moment."
      );
    } catch {}
    return;
  }

  // Acquire lock to prevent duplicate processing
  const lockAcquired = await acquireVoiceLock(voice.file_unique_id);
  if (!lockAcquired) {
    return; // Duplicate — silently skip
  }

  try {
    const supabase = createServerClient();

    // Look up user
    const { data: user } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", telegramUserId)
      .single();

    if (!user) {
      try {
        await bot.sendMessage(
          chatId,
          "Please open the app first to get started!",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Open App",
                    web_app: { url: process.env.NEXT_PUBLIC_APP_URL! },
                  },
                ],
              ],
            },
          }
        );
      } catch {}
      return;
    }

    // Get user's lists
    const { data: ownedLists } = await supabase
      .from("lists")
      .select("id, name")
      .eq("owner_id", user.id)
      .is("deleted_at", null);

    const { data: collabRecords } = await supabase
      .from("collaborators")
      .select("list_id, permission")
      .eq("user_id", user.id)
      .eq("status", "approved");

    let collabLists: any[] = [];
    const collabListIds = (collabRecords || [])
      .filter((c) => c.permission === "edit")
      .map((c) => c.list_id);

    if (collabListIds.length > 0) {
      const { data } = await supabase
        .from("lists")
        .select("id, name")
        .in("id", collabListIds)
        .is("deleted_at", null);
      collabLists = data || [];
    }

    const allLists = [...(ownedLists || []), ...collabLists];
    const uniqueLists = Array.from(
      new Map(allLists.map((l) => [l.id, l])).values()
    );

    if (uniqueLists.length === 0) {
      try {
        await bot.sendMessage(
          chatId,
          "You don't have any lists yet! Open the app to create your first list.",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Open App",
                    web_app: { url: process.env.NEXT_PUBLIC_APP_URL! },
                  },
                ],
              ],
            },
          }
        );
      } catch {}
      return;
    }

    // Validate file size before downloading
    if (voice.file_size && voice.file_size > MAX_VOICE_FILE_SIZE) {
      try {
        await bot.sendMessage(
          chatId,
          "That voice message is too long. Please keep it under 1 minute."
        );
      } catch {}
      return;
    }

    // Download voice file
    const fileUrl = await bot.getFileLink(voice.file_id);
    const audioResponse = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    if (audioBuffer.length > MAX_VOICE_FILE_SIZE) {
      try {
        await bot.sendMessage(
          chatId,
          "That voice message is too long. Please keep it under 1 minute."
        );
      } catch {}
      return;
    }

    // Process with Gemini
    const processor = getVoiceProcessor();
    const listNames = uniqueLists.map((l) => l.name);
    const result = await processor.process(audioBuffer, listNames);

    if (result.items.length === 0) {
      try {
        await bot.sendMessage(
          chatId,
          "Sorry, I couldn't understand that. Please try again or use the app."
        );
      } catch {}
      return;
    }

    // Group items by target list
    const listMap = new Map(
      uniqueLists.map((l) => [l.name.toLowerCase(), l])
    );

    // Process each item
    const receipts = new Map<
      string,
      { listName: string; added: string[]; removed: string[] }
    >();

    for (const voiceItem of result.items) {
      // Resolve target list
      let targetList = voiceItem.targetList
        ? listMap.get(voiceItem.targetList.toLowerCase())
        : null;

      // If not found, try fuzzy match on list name
      if (!targetList && voiceItem.targetList) {
        for (const [key, list] of listMap) {
          if (
            key.includes(voiceItem.targetList.toLowerCase()) ||
            voiceItem.targetList.toLowerCase().includes(key)
          ) {
            targetList = list;
            break;
          }
        }
      }

      // Default to first/only list
      if (!targetList) {
        if (uniqueLists.length === 1) {
          targetList = uniqueLists[0];
        } else {
          // Gemini couldn't determine — skip with message
          try {
            await bot.sendMessage(
              chatId,
              `I couldn't find a list named '${voiceItem.targetList}'. Open the app to create it.`
            );
          } catch {}
          continue;
        }
      }

      const receipt = receipts.get(targetList.id) || {
        listName: targetList.name,
        added: [],
        removed: [],
      };

      if (voiceItem.action === "add") {
        await processAddItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          user.id,
          receipt
        );
      } else {
        await processRemoveItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          receipt
        );
      }

      receipts.set(targetList.id, receipt);
    }

    // Send receipt messages
    for (const receipt of receipts.values()) {
      const lines: string[] = [];

      if (receipt.added.length > 0 && receipt.removed.length === 0) {
        lines.push(`Added to ${receipt.listName}:`);
        for (const item of receipt.added) {
          lines.push(`- ${item}`);
        }
      } else if (receipt.removed.length > 0 && receipt.added.length === 0) {
        lines.push(`Removed from ${receipt.listName}:`);
        for (const item of receipt.removed) {
          lines.push(`- ${item}`);
        }
      } else {
        lines.push(`Updated ${receipt.listName}:`);
        if (receipt.added.length > 0) {
          lines.push(`Added: ${receipt.added.join(", ")}`);
        }
        if (receipt.removed.length > 0) {
          lines.push(`Removed: ${receipt.removed.join(", ")}`);
        }
      }

      try {
        await bot.sendMessage(chatId, lines.join("\n"));
      } catch (e) {
        console.error("[VoiceHandler] Failed to send receipt:", e);
      }
    }
  } catch (error) {
    console.error("[VoiceHandler] Processing error:", error);
    try {
      await bot.sendMessage(
        chatId,
        "Sorry, I couldn't understand that. Please try again or use the app."
      );
    } catch {}
  } finally {
    await releaseVoiceLock(voice.file_unique_id);
  }
}

async function processAddItem(
  supabase: any,
  bot: TelegramBot,
  chatId: number,
  listId: string,
  voiceItem: VoiceItem,
  userId: string,
  receipt: { added: string[]; removed: string[] }
) {
  // Check for recyclable items via fuzzy match
  const matches = await findFuzzyMatch(listId, voiceItem.text);

  if (matches.length === 1) {
    const match = matches[0];
    // Check similarity threshold
    const similarity = textSimilarity(
      match.text.toLowerCase(),
      voiceItem.text.toLowerCase()
    );

    if (similarity > 0.6) {
      // High confidence — auto-recycle
      await recycleItem(match.id);
      receipt.added.push(`${match.text} (recycled)`);
      return;
    }
    // Low confidence (0.3–0.6) — fall through to create new item
  } else if (matches.length > 1) {
    // Multiple matches — only recycle if best match has high confidence
    const bestMatch = matches[0]; // Already sorted by similarity DESC
    const similarity = textSimilarity(
      bestMatch.text.toLowerCase(),
      voiceItem.text.toLowerCase()
    );
    if (similarity > 0.6) {
      await recycleItem(bestMatch.id);
      receipt.added.push(`${bestMatch.text} (recycled)`);
      return;
    }
    // Low confidence — fall through to create new item
  }

  // No match — create new item
  const { data: maxPosResult } = await supabase
    .from("items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (maxPosResult?.[0]?.position || 0) + 1;

  await supabase.from("items").insert({
    list_id: listId,
    text: voiceItem.text,
    position: nextPosition,
    created_by: userId,
  });

  receipt.added.push(voiceItem.text);
}

async function processRemoveItem(
  supabase: any,
  bot: TelegramBot,
  chatId: number,
  listId: string,
  voiceItem: VoiceItem,
  receipt: { added: string[]; removed: string[] }
) {
  // Search active items by exact match first
  const { data: exactMatches } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(voiceItem.text))
    .order("created_at", { ascending: false })
    .limit(1);

  if (exactMatches && exactMatches.length > 0) {
    // Soft-delete the most recent match
    await supabase
      .from("items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", exactMatches[0].id);
    receipt.removed.push(exactMatches[0].text);
    return;
  }

  // No exact match — try fuzzy on active items (limited to avoid fetching entire list)
  const { data: fuzzyActive } = await supabase
    .from("items")
    .select("id, text")
    .eq("list_id", listId)
    .eq("completed", false)
    .is("deleted_at", null)
    .limit(200);

  if (fuzzyActive) {
    const scored = fuzzyActive
      .map((item: any) => ({
        ...item,
        score: textSimilarity(
          item.text.toLowerCase(),
          voiceItem.text.toLowerCase()
        ),
      }))
      .filter((item: any) => item.score > 0.3)
      .sort((a: any, b: any) => b.score - a.score);

    if (scored.length > 0 && scored[0].score > 0.6) {
      await supabase
        .from("items")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", scored[0].id);
      receipt.removed.push(scored[0].text);
      return;
    }
  }

  // Check if it's already completed
  const { data: completedMatch } = await supabase
    .from("items")
    .select("text")
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .ilike("text", escapeIlike(voiceItem.text))
    .limit(1);

  if (completedMatch && completedMatch.length > 0) {
    try {
      await bot.sendMessage(
        chatId,
        `'${completedMatch[0].text}' is already checked off in the list.`
      );
    } catch {}
    return;
  }

  try {
    await bot.sendMessage(
      chatId,
      `Couldn't find '${voiceItem.text}' in the list.`
    );
  } catch {}
}

// Simple text similarity (Dice coefficient on character bigrams)
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.substring(i, i + 2));
  }

  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.substring(i, i + 2));
  }

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2.0 * intersection) / (bigramsA.size + bigramsB.size);
}
