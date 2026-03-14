import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { serverEnv } from "@/src/lib/env";
import type TelegramBot from "node-telegram-bot-api";
import type { TgVoice, TgFrom } from "@/src/services/voice-handler";

/** Telegram Update shape matching the webhook payload fields we route on */
interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramBot.CallbackQuery;
  message?: {
    chat: { id: number };
    from: TgFrom;
    voice?: TgVoice;
  };
}

export async function POST(request: NextRequest) {
  // Validate webhook secret
  const webhookSecret = serverEnv().TELEGRAM_WEBHOOK_SECRET;

  const providedSecret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );
  if (providedSecret !== webhookSecret) {
    console.warn("[Webhook] Invalid or missing secret token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TelegramUpdate;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle callback queries synchronously (must respond before Telegram's timeout)
  if (body.callback_query) {
    try {
      const { handleCallbackQuery } = await import("@/src/services/bot");
      await handleCallbackQuery(body.callback_query);
    } catch (error) {
      console.error("[Webhook] Error processing callback query:", error);
    }
    return NextResponse.json({ ok: true });
  }

  // Process asynchronously after response
  after(async () => {
    try {
      const bot = (await import("@/src/services/bot")).default;

      // Check for voice message
      if (body.message?.voice) {
        const { handleVoiceMessage } = await import(
          "@/src/services/voice-handler"
        );
        await handleVoiceMessage(
          body.message.chat.id,
          body.message.from.id,
          body.message.voice,
          body.message.from
        );
        return;
      }

      // Feed all other updates to bot for command handling
      bot.processUpdate(body as TelegramBot.Update);
    } catch (error) {
      console.error("[Webhook] Error processing update:", error);
    }
  });

  return NextResponse.json({ ok: true });
}
