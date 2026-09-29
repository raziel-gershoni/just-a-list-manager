import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-unmark-completed");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Reminders lists hold recurring occurrences: un-marking re-arms each completed
  // one, and re-completing it (undo) would mint a duplicate successor. The UI only
  // offers this on regular lists, but list-type changes aren't pushed to other open
  // clients, so enforce it here.
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("type")
    .eq("id", listId)
    .maybeSingle();
  if (listError) {
    return NextResponse.json({ error: "Failed to unmark items" }, { status: 500 });
  }
  if (list?.type === "reminders") {
    return NextResponse.json(
      { error: "Completed items on a reminders list can't be unmarked in bulk" },
      { status: 400 }
    );
  }

  // Flip all completed items back to active (non-destructive; reminders survive)
  const { data: unmarked, error } = await supabase
    .from("items")
    .update({ completed: false, completed_at: null })
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to unmark items" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    unmarked: (unmarked || []).length,
    unmarkedIds: (unmarked || []).map((i) => i.id),
  });
}
