import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { sendListReminder } from "@/src/services/bot";

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
  const { data: list } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .single();

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Get sender info
  const { data: sender } = await supabase
    .from("users")
    .select("name, telegram_id")
    .eq("id", auth.userId)
    .single();

  const senderName = sender?.name || "Someone";

  // Get all users with access: owner + approved collaborators, excluding sender
  const { data: listWithOwner } = await supabase
    .from("lists")
    .select("owner_id, users!lists_owner_id_fkey(id, telegram_id, language)")
    .eq("id", listId)
    .single();

  const { data: collaborators } = await supabase
    .from("collaborators")
    .select("user_id, users!collaborators_user_id_fkey(id, telegram_id, language)")
    .eq("list_id", listId)
    .eq("status", "approved");

  // Collect all recipients (excluding sender)
  const recipients: { telegramId: number; language: string }[] = [];

  // Add owner if not the sender
  const owner = (listWithOwner as any)?.users;
  if (owner && owner.id !== auth.userId && owner.telegram_id) {
    recipients.push({
      telegramId: owner.telegram_id,
      language: owner.language || "en",
    });
  }

  // Add collaborators (excluding sender)
  if (collaborators) {
    for (const collab of collaborators) {
      const user = (collab as any).users;
      if (user && user.id !== auth.userId && user.telegram_id) {
        recipients.push({
          telegramId: user.telegram_id,
          language: user.language || "en",
        });
      }
    }
  }

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
