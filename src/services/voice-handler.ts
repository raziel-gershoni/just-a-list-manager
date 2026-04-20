/**
 * Voice message handler — orchestrates the full voice processing pipeline.
 * Download OGG → Gemini multimodal → server-side recycling → apply mutations → receipt
 */

import TelegramBot from "node-telegram-bot-api";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/src/lib/supabase";
import { serverEnv } from "@/src/lib/env";
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

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

export interface TgFrom {
  id: number;
  first_name: string;
  last_name?: string;
  language_code?: string;
}

export async function handleVoiceMessage(
  chatId: number,
  telegramUserId: number,
  voice: TgVoice,
  from: TgFrom
) {
  const { default: bot, getMsg } = await import("./bot");

  let lang: string | undefined = from.language_code;

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
        getMsg(lang, "voice.rateLimited")
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
      .select("id, language, timezone")
      .eq("telegram_id", telegramUserId)
      .single();

    if (!user) {
      try {
        await bot.sendMessage(
          chatId,
          getMsg(lang, "voice.noUser"),
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Open App",
                    web_app: { url: serverEnv().NEXT_PUBLIC_APP_URL },
                  },
                ],
              ],
            },
          }
        );
      } catch {}
      return;
    }

    lang = user.language || from.language_code;

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

    let collabLists: { id: string; name: string }[] = [];
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
          getMsg(lang, "voice.noLists"),
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Open App",
                    web_app: { url: serverEnv().NEXT_PUBLIC_APP_URL },
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
          getMsg(lang, "voice.tooLong")
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
          getMsg(lang, "voice.tooLong")
        );
      } catch {}
      return;
    }

    // Process with Gemini
    const processor = getVoiceProcessor();
    const listNames = uniqueLists.map((l) => l.name);
    const result = await processor.process(audioBuffer, listNames, user.timezone || "UTC", new Date().toISOString());

    if (result.items.length === 0) {
      try {
        await bot.sendMessage(
          chatId,
          getMsg(lang, "voice.error")
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
              getMsg(lang, "voice.listNotFound").replace("{listName}", voiceItem.targetList || "")
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
        const itemId = await processAddItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          user.id,
          receipt,
          lang
        );

        // Create reminder if voice included a time
        if (itemId && voiceItem.remind_at) {
          await supabase
            .from("item_reminders")
            .update({ cancelled_at: new Date().toISOString() })
            .eq("item_id", itemId)
            .eq("created_by", user.id)
            .is("sent_at", null)
            .is("cancelled_at", null);

          await supabase.from("item_reminders").insert({
            item_id: itemId,
            list_id: targetList.id,
            created_by: user.id,
            remind_at: voiceItem.remind_at,
            is_shared: false,
            recurrence: voiceItem.recurrence ?? null,
          });

          receipt.added[receipt.added.length - 1] += " \u23F0";
        }
      } else {
        await processRemoveItem(
          supabase,
          bot,
          chatId,
          targetList.id,
          voiceItem,
          receipt,
          lang,
          targetList.name
        );
      }

      receipts.set(targetList.id, receipt);
    }

    // Send receipt messages
    for (const receipt of receipts.values()) {
      const lines: string[] = [];

      if (receipt.added.length > 0 && receipt.removed.length === 0) {
        lines.push(getMsg(lang, "voice.added").replace("{listName}", receipt.listName));
        for (const item of receipt.added) {
          lines.push(`- ${item}`);
        }
      } else if (receipt.removed.length > 0 && receipt.added.length === 0) {
        lines.push(getMsg(lang, "voice.removed").replace("{listName}", receipt.listName));
        for (const item of receipt.removed) {
          lines.push(`- ${item}`);
        }
      } else {
        lines.push(getMsg(lang, "voice.updated").replace("{listName}", receipt.listName));
        if (receipt.added.length > 0) {
          lines.push(getMsg(lang, "voice.addedInline").replace("{items}", receipt.added.join(", ")));
        }
        if (receipt.removed.length > 0) {
          lines.push(getMsg(lang, "voice.removedInline").replace("{items}", receipt.removed.join(", ")));
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
        getMsg(lang, "voice.error")
      );
    } catch {}
  } finally {
    await releaseVoiceLock(voice.file_unique_id);
  }
}

async function processAddItem(
  supabase: SupabaseClient,
  bot: TelegramBot,
  chatId: number,
  listId: string,
  voiceItem: VoiceItem,
  userId: string,
  receipt: { added: string[]; removed: string[] },
  lang: string | undefined
): Promise<string | null> {
  const { getMsg } = await import("./bot");
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
      await recycleItem(match.id, userId);
      receipt.added.push(`${match.text} ${getMsg(lang, "voice.recycledLabel")}`);
      return match.id;
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
      await recycleItem(bestMatch.id, userId);
      receipt.added.push(`${bestMatch.text} ${getMsg(lang, "voice.recycledLabel")}`);
      return bestMatch.id;
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

  const { data: created } = await supabase.from("items").insert({
    list_id: listId,
    text: voiceItem.text,
    position: nextPosition,
    created_by: userId,
  }).select("id").single();

  receipt.added.push(voiceItem.text);
  return created?.id ?? null;
}

async function processRemoveItem(
  supabase: SupabaseClient,
  bot: TelegramBot,
  chatId: number,
  listId: string,
  voiceItem: VoiceItem,
  receipt: { added: string[]; removed: string[] },
  lang: string | undefined,
  listName: string
) {
  const { getMsg } = await import("./bot");
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
      .map((item: { id: string; text: string }) => ({
        ...item,
        score: textSimilarity(
          item.text.toLowerCase(),
          voiceItem.text.toLowerCase()
        ),
      }))
      .filter((item) => item.score > 0.3)
      .sort((a, b) => b.score - a.score);

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
        getMsg(lang, "voice.alreadyCheckedOff")
          .replace("{item}", completedMatch[0].text)
          .replace("{listName}", listName)
      );
    } catch {}
    return;
  }

  try {
    await bot.sendMessage(
      chatId,
      getMsg(lang, "voice.notFound")
        .replace("{item}", voiceItem.text)
        .replace("{listName}", listName)
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
