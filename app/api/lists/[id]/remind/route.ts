import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { sendListReminder } from "@/src/services/bot";
import { resolveListRecipients } from "@/src/lib/list-notify";
import { dbError } from "@/src/lib/api-errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "list-remind");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to view this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Get list name
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .maybeSingle();
  if (listError) return dbError("Remind", "List read", listError, { listId });

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Get sender info. A reminder signed by the wrong person can't be taken back: send
  // nothing if the name can't be read. "Someone" is only for a sender with no row.
  const { data: sender, error: senderError } = await supabase
    .from("users")
    .select("name, telegram_id")
    .eq("id", auth.userId)
    .maybeSingle();
  if (senderError) return dbError("Remind", "Sender read", senderError, { listId, userId: auth.userId });

  const senderName = sender?.name || "Someone";

  // Owner + approved collaborators, excluding sender (see src/lib/list-notify.ts)
  const recipients = await resolveListRecipients(supabase, listId, auth.userId);

  // Send reminders
  let sent = 0;
  for (const recipient of recipients) {
    try {
      await sendListReminder(
        recipient.telegramId,
        recipient.language,
        senderName,
        list.name,
        listId
      );
      sent++;
    } catch (e) {
      console.error("[Remind] Failed to send to", recipient.telegramId, e);
    }
  }

  return NextResponse.json({ sent });
}
