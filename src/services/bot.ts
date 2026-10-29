/**
 * Telegram Bot Service
 * Handles bot commands and message sending.
 * Uses polling: false — webhook route feeds updates via processUpdate().
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";
import { serverEnv } from "@/src/lib/env";
import { redactTelegramErrors } from "@/src/lib/telegram-errors";
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
    redactTelegramErrors(TelegramBot);
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

type CommandHandler = (msg: TelegramBot.Message, match: RegExpExecArray | null) => Promise<void>;

// Command handlers still running. processUpdate calls onText handlers synchronously, so a
// handler's promise is in this set by the time processUpdate returns.
const inFlight = new Set<Promise<void>>();

// onText drops the promise an async handler returns, so a failure would otherwise be an
// unhandled rejection. Log it here instead, with the chat it came from, and track the
// promise so the webhook can wait for it (waitForBotHandlers).
function logFailures(command: string, handler: CommandHandler) {
  return (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
    const run = handler(msg, match).catch((err) => {
      console.error(`[Bot] ${command} handler failed, chatId:`, msg.chat.id, err);
    });
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  };
}

/**
 * Resolves once every command handler started so far has finished (failures are already
 * logged by logFailures). The webhook awaits this inside after(), so the function is not
 * frozen mid-handler. No timeout of its own: the platform's function limit applies.
 */
export async function waitForBotHandlers(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

function registerBotHandlers(botInstance: TelegramBot) {
  // Register /start command handler
  botInstance.onText(/\/start(.*)/, logFailures("/start", async (msg, match) => {
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

    const { error: upsertError } = await supabase.from("users").upsert(
      {
        telegram_id: telegramId,
        name,
        username: username || null,
        language,
      },
      { onConflict: "telegram_id" }
    );
    // Still send the welcome: the Mini App creates the row on first open (POST /api/user).
    if (upsertError) {
      console.error("[Bot] /start user upsert failed, telegramId:", telegramId, upsertError);
    }

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
  }));

  // /help command
  botInstance.onText(/\/help/, logFailures("/help", async (msg) => {
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
  }));
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
): Promise<boolean> {
  try {
    await bot.sendMessage(
      ownerTelegramId,
      getMsg(ownerLanguage, "bot.approvalRequest")
        .replace("{userName}", () => requesterName)
        .replace("{listName}", () => listName),
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
    return true;
  } catch (error) {
    console.error("[Bot] Failed to send approval request:", error);
    return false;
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
        .replace("{senderName}", () => senderName)
        .replace("{listName}", () => listName),
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

export async function sendListReady(
  telegramId: number,
  language: string,
  senderName: string,
  listName: string,
  listId: string
) {
  try {
    await bot.sendMessage(
      telegramId,
      getMsg(language, "bot.listReady")
        .replace("{senderName}", () => senderName)
        .replace("{listName}", () => listName),
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
    console.error("[Bot] Failed to send list ready:", error);
    throw error;
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
    const { data: collab, error: readError } = await supabase
      .from("collaborators")
      .select("*, users!collaborators_user_id_fkey(telegram_id, name, language), lists!collaborators_list_id_fkey(name, owner_id, users!lists_owner_id_fkey(telegram_id, language))")
      .eq("id", collaboratorId)
      .maybeSingle();

    // The owner's row was not loaded, so answer in the tapper's Telegram language. The
    // buttons stay on the message, so the owner can tap again.
    if (readError) {
      console.error("[Bot] Join request read failed, collaboratorId:", collaboratorId, readError);
      await bot.answerCallbackQuery(query.id, {
        text: getMsg(query.from.language_code, "errors.generic"),
      });
      return;
    }
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

    const requesterTgId = collabData.users?.telegram_id;
    const requesterName = collabData.users?.name || "Someone";
    const listName = collabData.lists?.name || "a list";
    const requesterLang = collabData.users?.language || "en";
    const ownerLang = collabData.lists?.users?.language || "en";

    // Update status
    const newStatus = isApprove ? "approved" : "declined";
    const { data: updatedRow, error: updateError } = await supabase
      .from("collaborators")
      .update({ status: newStatus })
      .eq("id", collaboratorId)
      .select("id")
      .maybeSingle();

    // Stop before telling the requester anything or editing the owner's message,
    // so the Approve / Decline buttons stay for another tap.
    if (updateError) {
      console.error("[Bot] Join request status update failed, collaboratorId:", collaboratorId, updateError);
      await bot.answerCallbackQuery(query.id, { text: getMsg(ownerLang, "errors.generic") });
      return;
    }
    // The request was deleted after it was read (the requester left): nothing changed, so
    // tell nobody and leave the owner's message alone.
    if (!updatedRow) {
      console.warn("[Bot] Join request was gone before the status update, collaboratorId:", collaboratorId);
      await bot.answerCallbackQuery(query.id, { text: "Request not found." });
      return;
    }

    // Notify requester
    if (requesterTgId) {
      try {
        if (isApprove) {
          await bot.sendMessage(
            requesterTgId,
            getMsg(requesterLang, "share.approvedMessage").replace("{listName}", () => listName),
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
            getMsg(requesterLang, "share.declinedMessage").replace("{listName}", () => listName)
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
          ? getMsg(ownerLang, "bot.approved").replace("{userName}", () => requesterName).replace("{listName}", () => listName)
          : getMsg(ownerLang, "bot.declined").replace("{userName}", () => requesterName).replace("{listName}", () => listName),
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to edit message:", e);
    }
  } else if (data.startsWith("reminder_")) {
    // Reminders were removed from the app (migration 028). Old reminder
    // messages still sit in chats, and their Done, Snooze and snooze-option
    // buttons land here. Without an answer Telegram keeps the button spinning.
    // Strip ALL buttons: Open List would open a list deleted with the feature.
    // Read-only on purpose: only the user's language is read, nothing is written.
    const { data: botUser, error: userError } = await supabase
      .from("users")
      .select("language")
      .eq("telegram_id", query.from.id)
      .maybeSingle();
    if (userError) {
      console.error("[Bot] Failed to read language for a removed reminder button:", userError);
    }
    const lang = botUser?.language || "en";

    try {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "bot.remindersRemoved") });
    } catch (e) {
      console.error("[Bot] Failed to answer a removed reminder button:", e);
    }

    if (!query.message) {
      console.warn(`[Bot] Removed reminder button "${data}" came without a message; no buttons to strip`);
      return;
    }

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }
      );
    } catch (e) {
      console.error("[Bot] Failed to strip buttons from an old reminder message:", e);
    }
  }
}
