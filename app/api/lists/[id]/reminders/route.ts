import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "reminders-list");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json({ error: "Permission denied" }, { status: 403 });
  }

  const supabase = createServerClient();
  const { data: reminders, error } = await supabase
    .from("item_reminders")
    .select("id, item_id, remind_at, is_shared, recurrence")
    .eq("list_id", listId)
    .eq("created_by", auth.userId)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .order("remind_at", { ascending: true });

  if (error) {
    console.error("[Reminders] List error:", error);
    return NextResponse.json({ error: "Failed to fetch reminders" }, { status: 500 });
  }

  return NextResponse.json({ reminders: reminders || [] });
}
