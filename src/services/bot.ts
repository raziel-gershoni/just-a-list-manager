/**
 * Telegram Bot Service
 * Handles bot commands and message sending.
 * Uses polling: false — webhook route feeds updates via processUpdate().
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";

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

  // Welcome message with menu button
  const welcomeMessages: Record<string, string> = {
    en: "Welcome to Just a List! \u{1F4DD}\n\nSend me a voice message to add items to your lists, or open the app to manage them.",
    he: "\u{05D1}\u{05E8}\u{05D5}\u{05DA} \u{05D4}\u{05D1}\u{05D0} \u{05DC}\u{05E1}\u{05EA}\u{05DD} \u{05E8}\u{05E9}\u{05D9}\u{05DE}\u{05D4}! \u{1F4DD}\n\n\u{05E9}\u{05DC}\u{05D7} \u{05DC}\u{05D9} \u{05D4}\u{05D5}\u{05D3}\u{05E2}\u{05D4} \u{05E7}\u{05D5}\u{05DC}\u{05D9}\u{05EA} \u{05DB}\u{05D3}\u{05D9} \u{05DC}\u{05D4}\u{05D5}\u{05E1}\u{05D9}\u{05E3} \u{05E4}\u{05E8}\u{05D9}\u{05D8}\u{05D9}\u{05DD} \u{05DC}\u{05E8}\u{05E9}\u{05D9}\u{05DE}\u{05D5}\u{05EA}, \u{05D0}\u{05D5} \u{05E4}\u{05EA}\u{05D7} \u{05D0}\u{05EA} \u{05D4}\u{05D0}\u{05E4}\u{05DC}\u{05D9}\u{05E7}\u{05E6}\u{05D9}\u{05D4} \u{05DC}\u{05E0}\u{05D9}\u{05D4}\u{05D5}\u{05DC}.",
    ru: "\u{0414}\u{043E}\u{0431}\u{0440}\u{043E} \u{043F}\u{043E}\u{0436}\u{0430}\u{043B}\u{043E}\u{0432}\u{0430}\u{0442}\u{044C} \u{0432} \u{041F}\u{0440}\u{043E}\u{0441}\u{0442}\u{043E} \u{0441}\u{043F}\u{0438}\u{0441}\u{043E}\u{043A}! \u{1F4DD}\n\n\u{041E}\u{0442}\u{043F}\u{0440}\u{0430}\u{0432}\u{044C}\u{0442}\u{0435} \u{0433}\u{043E}\u{043B}\u{043E}\u{0441}\u{043E}\u{0432}\u{043E}\u{0435} \u{0441}\u{043E}\u{043E}\u{0431}\u{0449}\u{0435}\u{043D}\u{0438}\u{0435}, \u{0447}\u{0442}\u{043E}\u{0431}\u{044B} \u{0434}\u{043E}\u{0431}\u{0430}\u{0432}\u{0438}\u{0442}\u{044C} \u{044D}\u{043B}\u{0435}\u{043C}\u{0435}\u{043D}\u{0442}\u{044B} \u{0432} \u{0441}\u{043F}\u{0438}\u{0441}\u{043A}\u{0438}, \u{0438}\u{043B}\u{0438} \u{043E}\u{0442}\u{043A}\u{0440}\u{043E}\u{0439}\u{0442}\u{0435} \u{043F}\u{0440}\u{0438}\u{043B}\u{043E}\u{0436}\u{0435}\u{043D}\u{0438}\u{0435}.",
  };

  await bot.sendMessage(
    chatId,
    welcomeMessages[language || "en"] || welcomeMessages.en,
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
  const helpMessages: Record<string, string> = {
    en: "Send me a voice message to add or remove items from your lists.\n\nExamples:\n\u2022 \"Add milk and eggs to Groceries\"\n\u2022 \"Remove bread from Shopping\"\n\nOpen the app to create and manage lists.",
    he: "\u{05E9}\u{05DC}\u{05D7} \u{05DC}\u{05D9} \u{05D4}\u{05D5}\u{05D3}\u{05E2}\u{05D4} \u{05E7}\u{05D5}\u{05DC}\u{05D9}\u{05EA} \u{05DB}\u{05D3}\u{05D9} \u{05DC}\u{05D4}\u{05D5}\u{05E1}\u{05D9}\u{05E3} \u{05D0}\u{05D5} \u{05DC}\u{05D4}\u{05E1}\u{05D9}\u{05E8} \u{05E4}\u{05E8}\u{05D9}\u{05D8}\u{05D9}\u{05DD} \u{05DE}\u{05D4}\u{05E8}\u{05E9}\u{05D9}\u{05DE}\u{05D5}\u{05EA} \u{05E9}\u{05DC}\u{05DA}.\n\n\u{05D3}\u{05D5}\u{05D2}\u{05DE}\u{05D0}\u{05D5}\u{05EA}:\n\u2022 \"\u{05EA}\u{05D5}\u{05E1}\u{05D9}\u{05E3} \u{05D7}\u{05DC}\u{05D1} \u{05D5}\u{05D1}\u{05D9}\u{05E6}\u{05D9}\u{05DD} \u{05DC}\u{05E7}\u{05E0}\u{05D9}\u{05D5}\u{05EA}\"\n\u2022 \"\u{05EA}\u{05E1}\u{05D9}\u{05E8} \u{05DC}\u{05D7}\u{05DD} \u{05DE}\u{05D4}\u{05E8}\u{05E9}\u{05D9}\u{05DE}\u{05D4}\"\n\n\u{05E4}\u{05EA}\u{05D7} \u{05D0}\u{05EA} \u{05D4}\u{05D0}\u{05E4}\u{05DC}\u{05D9}\u{05E7}\u{05E6}\u{05D9}\u{05D4} \u{05DC}\u{05D9}\u{05E6}\u{05D9}\u{05E8}\u{05D4} \u{05D5}\u{05E0}\u{05D9}\u{05D4}\u{05D5}\u{05DC} \u{05E8}\u{05E9}\u{05D9}\u{05DE}\u{05D5}\u{05EA}.",
    ru: "\u{041E}\u{0442}\u{043F}\u{0440}\u{0430}\u{0432}\u{044C}\u{0442}\u{0435} \u{043C}\u{043D}\u{0435} \u{0433}\u{043E}\u{043B}\u{043E}\u{0441}\u{043E}\u{0432}\u{043E}\u{0435} \u{0441}\u{043E}\u{043E}\u{0431}\u{0449}\u{0435}\u{043D}\u{0438}\u{0435}, \u{0447}\u{0442}\u{043E}\u{0431}\u{044B} \u{0434}\u{043E}\u{0431}\u{0430}\u{0432}\u{0438}\u{0442}\u{044C} \u{0438}\u{043B}\u{0438} \u{0443}\u{0434}\u{0430}\u{043B}\u{0438}\u{0442}\u{044C} \u{044D}\u{043B}\u{0435}\u{043C}\u{0435}\u{043D}\u{0442}\u{044B} \u{0438}\u{0437} \u{0441}\u{043F}\u{0438}\u{0441}\u{043A}\u{043E}\u{0432}.\n\n\u{041F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}\u{044B}:\n\u2022 \"\u{0414}\u{043E}\u{0431}\u{0430}\u{0432}\u{044C} \u{043C}\u{043E}\u{043B}\u{043E}\u{043A}\u{043E} \u{0438} \u{044F}\u{0439}\u{0446}\u{0430} \u{0432} \u{041F}\u{0440}\u{043E}\u{0434}\u{0443}\u{043A}\u{0442}\u{044B}\"\n\u2022 \"\u{0423}\u{0431}\u{0435}\u{0440}\u{0438} \u{0445}\u{043B}\u{0435}\u{0431} \u{0438}\u{0437} \u{041F}\u{043E}\u{043A}\u{0443}\u{043F}\u{043E}\u{043A}\"\n\n\u{041E}\u{0442}\u{043A}\u{0440}\u{043E}\u{0439}\u{0442}\u{0435} \u{043F}\u{0440}\u{0438}\u{043B}\u{043E}\u{0436}\u{0435}\u{043D}\u{0438}\u{0435} \u{0434}\u{043B}\u{044F} \u{0441}\u{043E}\u{0437}\u{0434}\u{0430}\u{043D}\u{0438}\u{044F} \u{0438} \u{0443}\u{043F}\u{0440}\u{0430}\u{0432}\u{043B}\u{0435}\u{043D}\u{0438}\u{044F} \u{0441}\u{043F}\u{0438}\u{0441}\u{043A}\u{0430}\u{043C}\u{0438}.",
  };

  await bot.sendMessage(
    chatId,
    helpMessages[lang || "en"] || helpMessages.en,
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
      `${requesterName} wants to join your list "${listName}"`,
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
            `You've been added to "${listName}"!`,
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
            `Your request to join "${listName}" was declined.`
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
          ? `\u2705 ${requesterName} has been added to "${listName}"`
          : `\u274C Request from ${requesterName} for "${listName}" was declined`,
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
