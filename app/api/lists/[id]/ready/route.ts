import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { sendListReady } from "@/src/services/bot";
import { resolveListRecipients } from "@/src/lib/list-notify";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "list-ready");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to view this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  const { data: list } = await supabase
    .from("lists")
    .select("name")
    .eq("id", listId)
    .single();

  if (!list) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  const { data: sender } = await supabase
    .from("users")
    .select("name")
    .eq("id", auth.userId)
    .single();

  const senderName = sender?.name || "Someone";

  // Owner + approved collaborators, excluding sender (see src/lib/list-notify.ts)
  const recipients = await resolveListRecipients(supabase, listId, auth.userId);

  let sent = 0;
  for (const recipient of recipients) {
    try {
      await sendListReady(
        recipient.telegramId,
        recipient.language,
        senderName,
        list.name,
        listId
      );
      sent++;
    } catch (e) {
      console.error("[Ready] Failed to send to", recipient.telegramId, e);
    }
  }

  return NextResponse.json({ sent });
}
