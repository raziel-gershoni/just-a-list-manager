/**
 * Telegram Bot Service
 * Handles bot commands and message sending.
 * Uses polling: false — webhook route feeds updates via processUpdate().
 */

import TelegramBot from "node-telegram-bot-api";
import { createServerClient } from "@/src/lib/supabase";
import { verifyListPermission } from "@/src/lib/api-auth";
import { completeRecurringItem } from "@/src/services/recurring";
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
    .replace("{itemText}", () => itemText)
    .replace("{listName}", () => listName);
  if (senderName) text = text.replace("{senderName}", () => senderName);

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
  } else if (data.startsWith("reminder_done:")) {
    const reminderId = data.replace("reminder_done:", "");

    // Get user language and internal id (id is needed for the permission check below)
    const { data: botUser } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", query.from.id)
      .single();
    const lang = botUser?.language || "en";

    // Look up the reminder
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, item_id, list_id, created_by, remind_at, is_shared, recurrence")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
      return;
    }

    // Telegram callback_data is chosen by the client at the protocol level, so a
    // modified client can send any reminder id. Verify the sender holds rights
    // on the reminder's list before completing the item — an unknown bot user
    // (no botUser.id) fails closed. The failure message is deliberately identical
    // to the "reminder not found" one above so a caller who lacks permission can't
    // tell "doesn't exist" apart from "exists but you can't touch it".
    //
    // Called at the "view" bar (not "edit"): a view-only collaborator can
    // legitimately have created this reminder themselves (the create route
    // only requires "view"), and Done writes to `items` — shared state — so
    // completing it still requires owner/editor, not merely being allowed to
    // view the list at all.
    const perm = botUser?.id
      ? await verifyListPermission(botUser.id, reminder.list_id, "view")
      : { allowed: false as const, role: null };
    const mayComplete = perm.allowed && (perm.role === "owner" || perm.role === "editor");
    if (!mayComplete) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
      return;
    }

    // Get item text and current state for the confirmation message + idempotency guard.
    // Scoped by list_id too: item_id and list_id are independent FKs (migration
    // 014) with nothing binding them, so a reminder row created while the
    // create-route guard didn't exist yet could still point cross-list. An
    // unscoped lookup would leak that other list's item text here.
    const { data: item } = await supabase
      .from("items")
      .select("text, completed, completed_at")
      .eq("id", reminder.item_id)
      .eq("list_id", reminder.list_id)
      .single();

    // On a mismatch this comes back null. Bail through the same notFound path
    // as every other denial above instead of falling back to a placeholder —
    // the old optional-chained default masked the null and let the branch
    // answer a false "done" confirmation for an item it never touched.
    if (!item) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
      return;
    }

    const itemText = item.text;

    // Idempotency: if the item was just completed (within 30s), treat this as a duplicate tap
    // and skip running the flow again. Prevents double-tap from creating duplicate occurrences.
    if (item.completed && item.completed_at) {
      const completedAge = Date.now() - new Date(item.completed_at).getTime();
      if (completedAge < 30_000) {
        await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.done") });
        return;
      }
    }

    if (reminder.recurrence) {
      // Recurring: complete item + create new occurrence
      // Keep the sent reminder (not cancelled) so completed item shows its time
      await completeRecurringItem(supabase, {
        itemId: reminder.item_id,
        listId: reminder.list_id,
        userId: reminder.created_by,
        text: itemText,
        remindAt: reminder.remind_at,
        recurrence: reminder.recurrence,
        isShared: reminder.is_shared,
      });
    } else {
      // One-time: mark item as completed.
      // Keep the reminder uncancelled so the completed item displays its original time
      // in the done section. The reminder is already sent and inert; if not yet sent,
      // the cron will silently mark it sent when due (since item is completed).
      await supabase
        .from("items")
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq("id", reminder.item_id)
        .eq("list_id", reminder.list_id);
    }

    await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.done") });

    try {
      await bot.editMessageText(
        getMsg(lang, "reminder.doneItem").replace("{itemText}", () => itemText),
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

    // Get user language and internal id (id is needed for the permission check below)
    const { data: botUser } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", query.from.id)
      .single();
    const lang = botUser?.language || "en";

    // Look up the reminder's list (and creator) so we can gate this on
    // permission. This branch is otherwise read-only, but a bare reminder id
    // would still let an attacker probe whether a given id exists in any
    // list at all.
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, list_id, created_by")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
      return;
    }

    // Same indistinguishability rationale as reminder_done above. Called at
    // the "view" bar: this branch only ever touches this one reminder row
    // (remind_at/sent_at, or just shows buttons), so — unlike Done — it's
    // fine to allow it when the sender is either an editor/owner OR the
    // reminder's own creator (a view-only collaborator's personal reminder).
    const perm = botUser?.id
      ? await verifyListPermission(botUser.id, reminder.list_id, "view")
      : { allowed: false as const, role: null };
    const maySnooze =
      perm.allowed &&
      (perm.role === "owner" || perm.role === "editor" || reminder.created_by === botUser?.id);
    if (!maySnooze) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(lang, "reminder.notFound") });
      return;
    }

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

    // Get the sender's internal id + language (needed for the permission check
    // below). Distinct from the reminder-creator lookup further down, which is
    // used only for timezone/lang when formatting the confirmation message.
    const { data: botUser } = await supabase
      .from("users")
      .select("id, language")
      .eq("telegram_id", query.from.id)
      .single();
    const senderLang = botUser?.language || "en";

    // Look up the reminder, item text, list (for the permission check), and user timezone.
    // Also fetch the item's own list_id so it can be compared to reminder.list_id
    // below — the two are independent FKs (migration 014) with nothing binding
    // them, so a mismatched row would otherwise let this read leak another
    // list's item text into the snooze confirmation.
    const { data: reminder } = await supabase
      .from("item_reminders")
      .select("id, remind_at, anchor_at, created_by, list_id, items!inner(text, list_id)")
      .eq("id", reminderId)
      .single();

    if (!reminder) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(senderLang, "reminder.notFound") });
      return;
    }

    // Same indistinguishability rationale as the other reminder_* branches.
    // Same "view" bar + creator-fallback rule as the show-buttons branch:
    // this only writes item_reminders.remind_at/sent_at on this one row, so
    // the reminder's own creator may snooze it even as a view-only
    // collaborator.
    const perm = botUser?.id
      ? await verifyListPermission(botUser.id, reminder.list_id, "view")
      : { allowed: false as const, role: null };
    const maySnooze =
      perm.allowed &&
      (perm.role === "owner" || perm.role === "editor" || reminder.created_by === botUser?.id);
    if (!maySnooze) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(senderLang, "reminder.notFound") });
      return;
    }

    const itemRow = reminder.items as unknown as { text: string; list_id: string };
    if (itemRow.list_id !== reminder.list_id) {
      await bot.answerCallbackQuery(query.id, { text: getMsg(senderLang, "reminder.notFound") });
      return;
    }
    const itemText = itemRow.text;
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

    // Update reminder: new remind_at, clear sent_at. The recurrence is KEPT.
    //
    // This used to null the recurrence, and that was correct when written
    // (46df943, 2026-04-18): the cron then inserted the next recurring reminder
    // on the same item when one fired, so a snoozed recurring reminder spawned a
    // second chain — which is what migration 018 cleaned up.
    //
    // cebd7ca (2026-04-21) removed that auto-advance and moved occurrence
    // creation to Done, but never revisited this branch. From then on, clearing
    // the recurrence simply ended the series: the snoozed reminder fired once
    // more and Done took the one-time branch below.
    //
    // Keeping it is safe as long as the cron does not insert follow-on reminders
    // (app/api/cron/reminders/route.ts stamps sent_at/cancelled_at only). If that
    // ever changes, this branch must be revisited. The series stays on its
    // original slot via anchor_at (migration 026), so a snooze does not shift it.
    await supabase
      .from("item_reminders")
      .update({
        remind_at: newRemindAt.toISOString(),
        sent_at: null,
        // Remember the series slot before moving off it. `??` keeps the ORIGINAL
        // across repeated snoozes instead of overwriting it with an already-snoozed time.
        anchor_at: reminder.anchor_at ?? reminder.remind_at,
      })
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
      text: getMsg(lang, "reminder.snoozed").replace("{time}", () => formattedTime),
    });

    try {
      await bot.editMessageText(
        getMsg(lang, "reminder.snoozedItem").replace("{itemText}", () => itemText).replace("{time}", () => formattedTime),
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
