import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/src/lib/supabase";
import { sendItemReminder } from "@/src/services/bot";
import { decideReminderDelivery } from "@/src/utils/reminder-suppression";

export async function GET(request: NextRequest) {
  // CRON_SECRET is auto-created by Vercel for cron jobs — not in serverEnvSchema
  // since it doesn't exist in local dev
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  let processed = 0;

  // Fetch due reminders with item and list info
  const { data: dueReminders, error } = await supabase
    .from("item_reminders")
    .select(`
      id, item_id, list_id, created_by, remind_at, is_shared, recurrence,
      items!inner(text, completed, deleted_at, list_id),
      lists!inner(name, deleted_at)
    `)
    .lte("remind_at", new Date().toISOString())
    .is("sent_at", null)
    .is("cancelled_at", null)
    .limit(50);

  if (error || !dueReminders) {
    console.error("[Cron/Reminders] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  for (const reminder of dueReminders) {
    try {
      const item = reminder.items as unknown as {
        text: string;
        completed: boolean;
        deleted_at: string | null;
        list_id: string;
      };
      const list = reminder.lists as unknown as {
        name: string;
        deleted_at: string | null;
      };

      // If item is completed, silently mark as sent (preserves time display in done section)
      // If item is deleted, cancel the reminder
      if (item.completed) {
        await supabase
          .from("item_reminders")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }
      if (item.deleted_at) {
        await supabase
          .from("item_reminders")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }

      // Get creator info
      const { data: creator } = await supabase
        .from("users")
        .select("telegram_id, language, name")
        .eq("id", reminder.created_by)
        .single();

      if (!creator) {
        console.error("[Cron/Reminders] Creator not found:", reminder.created_by);
        continue;
      }

      // Resolve recipients before deciding anything, so the personal and
      // shared shapes both go through the same suppression check.
      const recipients: string[] = [];
      if (reminder.is_shared) {
        // All list members: owner + approved collaborators
        const { data: listData } = await supabase
          .from("lists")
          .select("owner_id")
          .eq("id", reminder.list_id)
          .single();

        if (listData) recipients.push(listData.owner_id);

        const { data: collabs } = await supabase
          .from("collaborators")
          .select("user_id")
          .eq("list_id", reminder.list_id)
          .eq("status", "approved");

        for (const c of collabs || []) {
          if (!recipients.includes(c.user_id)) recipients.push(c.user_id);
        }
      } else {
        recipients.push(reminder.created_by);
      }

      // Archive is per-user: skip the recipients who archived this list.
      const { data: archivedRows } = await supabase
        .from("user_list_state")
        .select("user_id")
        .eq("list_id", reminder.list_id)
        .not("archived_at", "is", null)
        .in("user_id", recipients);

      const decision = decideReminderDelivery({
        listDeletedAt: list.deleted_at,
        recipients,
        archivedBy: new Set((archivedRows || []).map((r) => r.user_id)),
      });

      // Anything not delivered must still be stamped, or it stays in the
      // .limit(50) due window forever and eventually starves real reminders.
      if (decision.kind === "cancel") {
        await supabase
          .from("item_reminders")
          .update({ cancelled_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }

      if (decision.kind === "stamp-sent") {
        await supabase
          .from("item_reminders")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", reminder.id);
        continue;
      }

      for (const recipientId of decision.recipients) {
        const { data: member } = await supabase
          .from("users")
          .select("telegram_id, language")
          .eq("id", recipientId)
          .single();

        if (!member?.telegram_id) continue;
        try {
          await sendItemReminder(
            member.telegram_id,
            member.language || "en",
            item.text,
            list.name,
            reminder.list_id,
            reminder.id,
            recipientId !== reminder.created_by ? creator.name : undefined
          );
        } catch (e) {
          console.error("[Cron/Reminders] Failed to send to:", recipientId, e);
        }
      }

      // Mark as sent (next occurrence created when user acknowledges via "Done")
      await supabase
        .from("item_reminders")
        .update({ sent_at: new Date().toISOString() })
        .eq("id", reminder.id);

      processed++;
    } catch (e) {
      console.error("[Cron/Reminders] Error processing reminder:", reminder.id, e);
    }
  }

  return NextResponse.json({ processed });
}
