/**
 * Telegram Bot Service
 * Handles bot commands and message sending.
 * Uses polling: false — webhook route feeds updates via processUpdate().
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";
import enMessages from "@/messages/en.json";
import heMessages from "@/messages/he.json";
import ruMessages from "@/messages/ru.json";

const allMessages: Record<string, typeof enMessages> = {
  en: enMessages,
  he: heMessages,
  ru: ruMessages,
};

export function getMsg(lang: string | undefined, path: string): string {
  const msgs = allMessages[lang || "en"] || allMessages.en;
  const keys = path.split(".");
  let val: any = msgs;
  for (const k of keys) {
    val = val?.[k];
  }
  return (val as string) || "";
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, {
  polling: false,
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;
const BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME!;

// Register /start command handler
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const firstName = msg.from!.first_name;
  const lastName = msg.from?.last_name;
  const username = msg.from?.username;
  const languageCode = msg.from?.language_code;

  const supabase = createServerClient();

  // Upsert user
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const language = ["en", "he", "ru"].includes(languageCode || "")
    ? languageCode
    : "en";

  await supabase.from("users").upsert(
    {
      telegram_id: telegramId,
      name,
      username: username || null,
      language,
    },
    { onConflict: "telegram_id" }
  );

  // Check for deep link start param (invite flow)
  const startParam = match?.[1]?.trim();
  if (startParam?.startsWith("invite_")) {
    const token = startParam.replace("invite_", "");
    await bot.sendMessage(
      chatId,
      `Open the app to accept the invitation:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Open App",
                web_app: { url: `${APP_URL}/invite/${token}` },
              },
            ],
          ],
        },
      }
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    getMsg(language, "bot.welcome"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open App", web_app: { url: APP_URL } }],
        ],
      },
    }
  );

  // Set menu button for this chat
  try {
    await bot.setChatMenuButton({
      chat_id: chatId,
      menu_button: {
        type: "web_app",
        text: "Open App",
        web_app: { url: APP_URL },
      },
    });
  } catch (e) {
    console.error("[Bot] Failed to set menu button:", e);
  }
});

// /help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = msg.from?.language_code;

  await bot.sendMessage(
    chatId,
    getMsg(lang, "bot.help"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open App", web_app: { url: APP_URL } }],
        ],
      },
    }
  );
});

export default bot;

export async function sendApprovalRequest(
  ownerTelegramId: number,
  requesterId: string,
  requesterName: string,
  listId: string,
  listName: string,
  collaboratorId: string
) {
  try {
    await bot.sendMessage(
      ownerTelegramId,
      getMsg("en", "bot.approvalRequest")
        .replace("{userName}", requesterName)
        .replace("{listName}", listName),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Approve \u2705",
                callback_data: `approve:${collaboratorId}`,
              },
              {
                text: "Decline \u274C",
                callback_data: `decline:${collaboratorId}`,
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error("[Bot] Failed to send approval request:", error);
  }
}

// Handle approval/decline callbacks
bot.on("callback_query", async (query) => {
  const data = query.data;
  if (!data) return;

  const supabase = createServerClient();

  if (data.startsWith("approve:") || data.startsWith("decline:")) {
    const [action, collaboratorId] = data.split(":");
    const isApprove = action === "approve";

    // Get collaborator details with list owner info
    const { data: collab } = await supabase
      .from("collaborators")
      .select("*, users!collaborators_user_id_fkey(telegram_id, name), lists!collaborators_list_id_fkey(name, owner_id, users!lists_owner_id_fkey(telegram_id))")
      .eq("id", collaboratorId)
      .single();

    if (!collab) {
      await bot.answerCallbackQuery(query.id, {
        text: "Request not found.",
      });
      return;
    }

    // Verify the callback sender is the list owner
    const ownerTelegramId = (collab as any).lists?.users?.telegram_id;
    if (!query.from?.id || query.from.id !== ownerTelegramId) {
      await bot.answerCallbackQuery(query.id, {
        text: "Only the list owner can approve or decline.",
      });
      return;
    }

    // Update status
    const newStatus = isApprove ? "approved" : "declined";
    await supabase
      .from("collaborators")
      .update({ status: newStatus })
      .eq("id", collaboratorId);

    const requesterTgId = (collab as any).users?.telegram_id;
    const requesterName = (collab as any).users?.name || "Someone";
    const listName = (collab as any).lists?.name || "a list";

    // Notify requester
    if (requesterTgId) {
      try {
        if (isApprove) {
          await bot.sendMessage(
            requesterTgId,
            getMsg("en", "share.approvedMessage").replace("{listName}", listName),
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Open List", web_app: { url: APP_URL } }],
                ],
              },
            }
          );
        } else {
          await bot.sendMessage(
            requesterTgId,
            getMsg("en", "share.declinedMessage").replace("{listName}", listName)
          );
        }
      } catch (e) {
        console.error("[Bot] Failed to notify requester:", e);
      }
    }

    // Update the owner's message
    await bot.answerCallbackQuery(query.id, {
      text: isApprove ? "Approved!" : "Declined.",
    });

    // Edit the original message to reflect the decision
    try {
      await bot.editMessageText(
        isApprove
          ? getMsg("en", "bot.approved").replace("{userName}", requesterName).replace("{listName}", listName)
          : getMsg("en", "bot.declined").replace("{userName}", requesterName).replace("{listName}", listName),
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  }
});
