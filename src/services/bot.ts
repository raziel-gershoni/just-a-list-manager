/**
 * Telegram Bot Service
 * Handles bot commands and message sending.
 * Uses polling: false — webhook route feeds updates via processUpdate().
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";
import { serverEnv } from "@/src/lib/env";
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
  let val: unknown = msgs;
  for (const k of keys) {
    val = (val as Record<string, unknown>)?.[k];
  }
  return (val as string) || "";
}

let _bot: TelegramBot | null = null;
function getBot(): TelegramBot {
  if (!_bot) {
    _bot = new TelegramBot(serverEnv().TELEGRAM_BOT_TOKEN, {
      polling: false,
    });
    // Register command handlers on first init
    registerBotHandlers(_bot);
  }
  return _bot;
}

// Expose as default export via proxy so consumers don't need to change calling code
const bot = new Proxy({} as TelegramBot, {
  get(_, prop) {
    return Reflect.get(getBot(), prop);
  },
});

function getAppUrl(): string {
  return serverEnv().NEXT_PUBLIC_APP_URL;
}

function registerBotHandlers(botInstance: TelegramBot) {
  // Register /start command handler
  botInstance.onText(/\/start(.*)/, async (msg, match) => {
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
      await botInstance.sendMessage(
        chatId,
        `Open the app to accept the invitation:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Open App",
                  web_app: { url: `${getAppUrl()}/invite/${token}` },
                },
              ],
            ],
          },
        }
      );
      return;
    }

    await botInstance.sendMessage(
      chatId,
      getMsg(language, "bot.welcome"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Open App", web_app: { url: getAppUrl() } }],
          ],
        },
      }
    );

    // Set menu button for this chat
    try {
      await botInstance.setChatMenuButton({
        chat_id: chatId,
        menu_button: {
          type: "web_app",
          text: "Open App",
          web_app: { url: getAppUrl() },
        },
      });
    } catch (e) {
      console.error("[Bot] Failed to set menu button:", e);
    }
  });

  // /help command
  botInstance.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const lang = msg.from?.language_code;

    await botInstance.sendMessage(
      chatId,
      getMsg(lang, "bot.help"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Open App", web_app: { url: getAppUrl() } }],
          ],
        },
      }
    );
  });
}

export default bot;

export async function sendApprovalRequest(
  ownerTelegramId: number,
  requesterId: string,
  requesterName: string,
  listId: string,
  listName: string,
  collaboratorId: string,
  ownerLanguage: string
) {
  try {
    await bot.sendMessage(
      ownerTelegramId,
      getMsg(ownerLanguage, "bot.approvalRequest")
        .replace("{userName}", requesterName)
        .replace("{listName}", listName),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${getMsg(ownerLanguage, "share.approveRequest")} \u2705`,
                callback_data: `approve:${collaboratorId}`,
              },
              {
                text: `${getMsg(ownerLanguage, "share.declineRequest")} \u274C`,
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

export async function sendListReminder(
  telegramId: number,
  language: string,
  senderName: string,
  listName: string,
  listId: string
) {
  try {
    await bot.sendMessage(
      telegramId,
      getMsg(language, "bot.listReminder")
        .replace("{senderName}", senderName)
        .replace("{listName}", listName),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: getMsg(language, "bot.openList"),
                web_app: { url: `${getAppUrl()}/list/${listId}` },
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error("[Bot] Failed to send list reminder:", error);
    throw error;
  }
}

export async function sendItemReminder(
  telegramId: number,
  language: string,
  itemText: string,
  listName: string,
  listId: string,
  reminderId: string,
  senderName?: string
) {
  const msgKey = senderName ? "bot.itemReminderShared" : "bot.itemReminder";
  let text = getMsg(language, msgKey)
    .replace("{itemText}", itemText)
    .replace("{listName}", listName);
  if (senderName) text = text.replace("{senderName}", senderName);

  await bot.sendMessage(telegramId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `\u2705 ${getMsg(language, "reminder.done")}`, callback_data: `reminder_done:${reminderId}` },
          { text: `\u23F0 ${getMsg(language, "reminder.snooze")}`, callback_data: `reminder_snooze:${reminderId}` },
        ],
        [
          { text: getMsg(language, "bot.openList"), web_app: { url: `${getAppUrl()}/list/${listId}` } },
        ],
      ],
    },
  });
}

// Handle approval/decline callbacks (called directly from webhook route)
export async function handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const supabase = createServerClient();

  if (data.startsWith("approve:") || data.startsWith("decline:")) {
    const [action, collaboratorId] = data.split(":");
    const isApprove = action === "approve";

    // Get collaborator details with list owner info
    const { data: collab } = await supabase
      .from("collaborators")
      .select("*, users!collaborators_user_id_fkey(telegram_id, name, language), lists!collaborators_list_id_fkey(name, owner_id, users!lists_owner_id_fkey(telegram_id, language))")
      .eq("id", collaboratorId)
      .single();

    if (!collab) {
      await bot.answerCallbackQuery(query.id, {
        text: "Request not found.",
      });
      return;
    }

    // Cast the joined query result to access nested relations
    const collabData = collab as typeof collab & {
      users?: { telegram_id?: number; name?: string; language?: string };
      lists?: { name?: string; users?: { telegram_id?: number; language?: string } };
    };

    // Verify the callback sender is the list owner
    const ownerTelegramId = collabData.lists?.users?.telegram_id;
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

    const requesterTgId = collabData.users?.telegram_id;
    const requesterName = collabData.users?.name || "Someone";
    const listName = collabData.lists?.name || "a list";
    const requesterLang = collabData.users?.language || "en";
    const ownerLang = collabData.lists?.users?.language || "en";

    // Notify requester
    if (requesterTgId) {
      try {
        if (isApprove) {
          await bot.sendMessage(
            requesterTgId,
            getMsg(requesterLang, "share.approvedMessage").replace("{listName}", listName),
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Open List", web_app: { url: getAppUrl() } }],
                ],
              },
            }
          );
        } else {
          await bot.sendMessage(
            requesterTgId,
            getMsg(requesterLang, "share.declinedMessage").replace("{listName}", listName)
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
          ? getMsg(ownerLang, "bot.approved").replace("{userName}", requesterName).replace("{listName}", listName)
          : getMsg(ownerLang, "bot.declined").replace("{userName}", requesterName).replace("{listName}", listName),
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  } else if (data.startsWith("reminder_done:")) {
    const reminderId = data.replace("reminder_done:", "");

    // Look up the reminder
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, item_id, list_id")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: "Reminder not found." });
      return;
    }

    // Get item text for the confirmation message
    const { data: item } = await supabase
      .from("items")
      .select("text")
      .eq("id", reminder.item_id)
      .single();

    const itemText = item?.text || "Item";

    // Mark item as completed
    await supabase
      .from("items")
      .update({ completed: true, completed_at: new Date().toISOString() })
      .eq("id", reminder.item_id);

    // Cancel the reminder
    await supabase
      .from("item_reminders")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("id", reminderId);

    await bot.answerCallbackQuery(query.id, { text: "Done!" });

    try {
      await bot.editMessageText(
        `\u2705 ${itemText} \u2014 done`,
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  } else if (data.match(/^reminder_snooze:[^:]+$/)) {
    // Show snooze time buttons
    const reminderId = data.replace("reminder_snooze:", "");

    await bot.answerCallbackQuery(query.id);

    try {
      await bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              { text: "30 min", callback_data: `reminder_snooze:${reminderId}:30m` },
              { text: "1 hour", callback_data: `reminder_snooze:${reminderId}:1h` },
            ],
            [
              { text: "3 hours", callback_data: `reminder_snooze:${reminderId}:3h` },
              { text: "Tomorrow", callback_data: `reminder_snooze:${reminderId}:tomorrow` },
            ],
          ],
        },
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  } else if (data.match(/^reminder_snooze:[^:]+:(30m|1h|3h|tomorrow)$/)) {
    const parts = data.split(":");
    const reminderId = parts[1];
    const duration = parts[2];

    // Look up the reminder to get the original remind_at
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, remind_at")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: "Reminder not found." });
      return;
    }

    const originalTime = new Date(reminder.remind_at);
    let newRemindAt: Date;

    switch (duration) {
      case "30m":
        newRemindAt = new Date(originalTime.getTime() + 30 * 60 * 1000);
        break;
      case "1h":
        newRemindAt = new Date(originalTime.getTime() + 60 * 60 * 1000);
        break;
      case "3h":
        newRemindAt = new Date(originalTime.getTime() + 3 * 60 * 60 * 1000);
        break;
      case "tomorrow":
        newRemindAt = new Date(originalTime);
        newRemindAt.setDate(newRemindAt.getDate() + 1);
        break;
      default:
        newRemindAt = new Date(originalTime.getTime() + 30 * 60 * 1000);
    }

    // Update reminder: new remind_at, clear sent_at
    await supabase
      .from("item_reminders")
      .update({ remind_at: newRemindAt.toISOString(), sent_at: null })
      .eq("id", reminderId);

    const formattedTime = newRemindAt.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    await bot.answerCallbackQuery(query.id, {
      text: `Snoozed until ${formattedTime}`,
    });

    try {
      await bot.editMessageText(
        `\u23F0 Snoozed until ${formattedTime}`,
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  }
}
