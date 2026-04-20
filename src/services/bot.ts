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

export async function sendReminderDigest(
  telegramId: number,
  language: string,
  digestType: "morning" | "evening",
  items: { text: string; listName: string; time: string }[]
) {
  const header = getMsg(language, digestType === "morning" ? "bot.digestMorning" : "bot.digestEvening");
  const lines = items.map((i) => `• ${i.time} — ${i.text} (${i.listName})`);
  const text = `${header}\n\n${lines.join("\n")}`;

  try {
    await bot.sendMessage(telegramId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: getMsg(language, "bot.openApp"), web_app: { url: getAppUrl() } }],
        ],
      },
    });
  } catch (error) {
    console.error("[Bot] Failed to send reminder digest:", error);
  }
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

    // Get user language
    const { data: botUser } = await supabase
      .from("users")
      .select("language")
      .eq("telegram_id", query.from.id)
      .single();
    const lang = botUser?.language || "en";

    // Look up the reminder
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, item_id, list_id")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
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

    await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.done") });

    try {
      await bot.editMessageText(
        getMsg(lang, "reminder.doneItem").replace("{itemText}", itemText),
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

    // Get user language
    const { data: botUser } = await supabase
      .from("users")
      .select("language")
      .eq("telegram_id", query.from.id)
      .single();
    const lang = botUser?.language || "en";

    await bot.answerCallbackQuery(query.id);

    try {
      await bot.editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              { text: getMsg(lang, "reminder.snooze30m"), callback_data: `reminder_snooze:${reminderId}:30m` },
              { text: getMsg(lang, "reminder.snooze1h"), callback_data: `reminder_snooze:${reminderId}:1h` },
            ],
            [
              { text: getMsg(lang, "reminder.snooze3h"), callback_data: `reminder_snooze:${reminderId}:3h` },
              { text: getMsg(lang, "reminder.snoozeTomorrow"), callback_data: `reminder_snooze:${reminderId}:tomorrow` },
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

    // Look up the reminder, item text, and user timezone
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, remind_at, created_by, items!inner(text)")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: "Reminder not found." });
      return;
    }

    const itemText = (reminder.items as unknown as { text: string }).text;
    // Note: lang for this handler is fetched below with timezone
    const originalTime = new Date(reminder.remind_at);
    const round5 = (d: Date) => { d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); return d; };
    let newRemindAt: Date;

    switch (duration) {
      case "30m":
        newRemindAt = round5(new Date(originalTime.getTime() + 30 * 60 * 1000));
        break;
      case "1h":
        newRemindAt = round5(new Date(originalTime.getTime() + 60 * 60 * 1000));
        break;
      case "3h":
        newRemindAt = round5(new Date(originalTime.getTime() + 3 * 60 * 60 * 1000));
        break;
      case "tomorrow":
        newRemindAt = new Date(originalTime);
        newRemindAt.setDate(newRemindAt.getDate() + 1);
        break;
      default:
        newRemindAt = round5(new Date(originalTime.getTime() + 30 * 60 * 1000));
    }

    // Update reminder: new remind_at, clear sent_at, and clear recurrence
    // (the next recurring instance was already created when this reminder fired,
    // so the snoozed copy should be one-time only)
    await supabase
      .from("item_reminders")
      .update({ remind_at: newRemindAt.toISOString(), sent_at: null, recurrence: null })
      .eq("id", reminderId);

    // Get user timezone and language for display
    let tz = "UTC";
    let lang = "en";
    if (reminder.created_by) {
      const { data: user } = await supabase
        .from("users")
        .select("timezone, language")
        .eq("id", reminder.created_by)
        .single();
      if (user?.timezone) tz = user.timezone;
      if (user?.language) lang = user.language;
    }

    // Smart time formatting: time-only for today, "Tomorrow HH:mm" for tomorrow, "Mon DD, HH:mm" for later
    const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const remindInTz = new Date(newRemindAt.toLocaleString("en-US", { timeZone: tz }));
    const isToday = nowInTz.toDateString() === remindInTz.toDateString();
    const tmrw = new Date(nowInTz); tmrw.setDate(tmrw.getDate() + 1);
    const isTomorrow = tmrw.toDateString() === remindInTz.toDateString();

    const timePart = newRemindAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    let formattedTime: string;
    if (isToday) {
      formattedTime = timePart;
    } else if (isTomorrow) {
      formattedTime = `${getMsg(lang, "reminder.snoozeTomorrow")} ${timePart}`;
    } else {
      formattedTime = newRemindAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz }) + `, ${timePart}`;
    }

    await bot.answerCallbackQuery(query.id, {
      text: getMsg(lang, "reminder.snoozed").replace("{time}", formattedTime),
    });

    try {
      await bot.editMessageText(
        getMsg(lang, "reminder.snoozedItem").replace("{itemText}", itemText).replace("{time}", formattedTime),
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
