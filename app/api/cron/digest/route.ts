import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/src/lib/supabase";
import { sendReminderDigest } from "@/src/services/bot";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const nowUtc = new Date();
  let sent = 0;

  // Find users who have active reminders and a stored timezone
  const { data: usersWithReminders, error } = await supabase
    .from("item_reminders")
    .select("created_by")
    .is("sent_at", null)
    .is("cancelled_at", null)
    .gt("remind_at", nowUtc.toISOString());

  if (error || !usersWithReminders) {
    console.error("[Cron/Digest] Query error:", error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  // Deduplicate user IDs
  const userIds = [...new Set(usersWithReminders.map((r) => r.created_by))];

  for (const userId of userIds) {
    try {
      const { data: user } = await supabase
        .from("users")
        .select("telegram_id, language, timezone")
        .eq("id", userId)
        .single();

      if (!user?.telegram_id || !user.timezone) continue;

      // Calculate user's current local hour
      const localHour = getLocalHour(nowUtc, user.timezone);
      if (localHour === null) continue;

      let digestType: "morning" | "evening" | null = null;
      if (localHour === 7) digestType = "morning";
      else if (localHour === 19) digestType = "evening";
      else continue;

      // Get the relevant date range in UTC for the user's local day
      const { start, end } = getLocalDayRange(nowUtc, user.timezone, digestType === "evening" ? 1 : 0);

      // Fetch reminders in that range
      const { data: reminders } = await supabase
        .from("item_reminders")
        .select("remind_at, items!inner(text, completed, deleted_at), lists!inner(id, name, deleted_at)")
        .eq("created_by", userId)
        .is("sent_at", null)
        .is("cancelled_at", null)
        .gte("remind_at", start.toISOString())
        .lt("remind_at", end.toISOString())
        .order("remind_at", { ascending: true })
        .limit(20);

      // Archive is per-user, so this lookup is scoped to the digest recipient.
      const { data: archivedRows } = await supabase
        .from("user_list_state")
        .select("list_id")
        .eq("user_id", userId)
        .not("archived_at", "is", null);
      const archivedListIds = new Set(
        (archivedRows || []).map((r) => r.list_id)
      );

      // Exclude reminders whose item is completed or deleted, and whose list
      // is deleted or archived by this user.
      const liveReminders = (reminders || []).filter((r) => {
        const item = r.items as unknown as { completed: boolean; deleted_at: string | null };
        const list = r.lists as unknown as { id: string; deleted_at: string | null };
        return (
          !item.completed &&
          !item.deleted_at &&
          !list.deleted_at &&
          !archivedListIds.has(list.id)
        );
      });

      if (liveReminders.length === 0) continue;

      const items = liveReminders.map((r) => {
        const item = r.items as unknown as { text: string };
        const list = r.lists as unknown as { name: string };
        const time = new Date(r.remind_at).toLocaleTimeString(user.language || "en", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: user.timezone,
        });
        return { text: item.text, listName: list.name, time };
      });

      await sendReminderDigest(
        user.telegram_id,
        user.language || "en",
        digestType,
        items
      );
      sent++;
    } catch (e) {
      console.error("[Cron/Digest] Error for user:", userId, e);
    }
  }

  return NextResponse.json({ sent });
}

function getLocalHour(utcDate: Date, timezone: string): number | null {
  try {
    const formatted = utcDate.toLocaleString("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    });
    return parseInt(formatted, 10);
  } catch {
    return null;
  }
}

/** Get UTC start/end of a user's local day (offset 0 = today, 1 = tomorrow) */
function getLocalDayRange(
  utcDate: Date,
  timezone: string,
  dayOffset: number
): { start: Date; end: Date } {
  // Get the user's local date string
  const localDate = new Date(
    utcDate.toLocaleString("en-US", { timeZone: timezone })
  );
  localDate.setDate(localDate.getDate() + dayOffset);
  localDate.setHours(0, 0, 0, 0);

  // Convert local midnight back to UTC by finding the offset
  const localMidnightStr = localDate.toLocaleString("en-US", { timeZone: timezone });
  const utcMidnightStr = localDate.toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs =
    new Date(utcMidnightStr).getTime() - new Date(localMidnightStr).getTime();

  const start = new Date(localDate.getTime() + offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
}
