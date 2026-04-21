import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/src/lib/supabase";
import { sendItemReminder } from "@/src/services/bot";

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
      lists!inner(name)
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
      const list = reminder.lists as unknown as { name: string };

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

      if (reminder.is_shared) {
        // Send to all list members: owner + approved collaborators
        // Get list owner
        const { data: listData } = await supabase
          .from("lists")
          .select("owner_id")
          .eq("id", reminder.list_id)
          .single();

        const memberIds: string[] = [];
        if (listData) memberIds.push(listData.owner_id);

        // Get approved collaborators
        const { data: collabs } = await supabase
          .from("collaborators")
          .select("user_id")
          .eq("list_id", reminder.list_id)
          .eq("status", "approved");

        if (collabs) {
          for (const c of collabs) {
            if (!memberIds.includes(c.user_id)) {
              memberIds.push(c.user_id);
            }
          }
        }

        // Send to each member
        for (const memberId of memberIds) {
          const { data: member } = await supabase
            .from("users")
            .select("telegram_id, language")
            .eq("id", memberId)
            .single();

          if (member?.telegram_id) {
            try {
              await sendItemReminder(
                member.telegram_id,
                member.language || "en",
                item.text,
                list.name,
                reminder.list_id,
                reminder.id,
                memberId !== reminder.created_by ? creator.name : undefined
              );
            } catch (e) {
              console.error("[Cron/Reminders] Failed to send to member:", memberId, e);
            }
          }
        }
      } else {
        // Send only to creator
        if (creator.telegram_id) {
          await sendItemReminder(
            creator.telegram_id,
            creator.language || "en",
            item.text,
            list.name,
            reminder.list_id,
            reminder.id
          );
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
