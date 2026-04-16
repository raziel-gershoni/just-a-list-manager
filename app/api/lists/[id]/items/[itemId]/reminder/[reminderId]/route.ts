import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string; reminderId: string }> }
) {
  const { id: listId, itemId, reminderId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "reminder-cancel");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to access this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Only the creator can cancel their own reminder
  const { data: reminder, error: fetchError } = await supabase
    .from("item_reminders")
    .select("id, created_by")
    .eq("id", reminderId)
    .eq("item_id", itemId)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .single();

  if (fetchError || !reminder) {
    return NextResponse.json(
      { error: "Reminder not found" },
      { status: 404 }
    );
  }

  if (reminder.created_by !== auth.userId) {
    return NextResponse.json(
      { error: "Only the creator can cancel this reminder" },
      { status: 403 }
    );
  }

  const { error } = await supabase
    .from("item_reminders")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", reminderId);

  if (error) {
    return NextResponse.json(
      { error: "Failed to cancel reminder" },
      { status: 500 }
    );
  }

  return NextResponse.json({ cancelled: true });
}
