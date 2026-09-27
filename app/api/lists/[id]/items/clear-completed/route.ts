import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-clear-completed");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Soft-delete all completed items (for undo support). Recurring staples are
  // excluded: they stay parked in the Recurring drawer on their completion
  // clock rather than being retired — delete-is-final vetoes respawn on
  // deleted_at (src/utils/recurring-respawn.ts), so soft-deleting a parked
  // recurring row here would destroy it permanently instead of just clearing
  // it. See docs/superpowers/specs/2026-09-08-delete-is-final-design.md.
  const { data: cleared, error } = await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
    .eq("completed", true)
    .eq("recurring", false)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to clear items" },
      { status: 500 }
    );
  }

  // Deliberately does NOT cancel reminders on cleared items here. Completing an
  // item never cancels its reminder (a completed item still shows the
  // reminder's original time), so a completed item routinely carries a live
  // reminder — and undo (useItemHandlers.ts) only ever PATCHes deleted_at back
  // to null, never un-cancels anything. Cancelling here made undo lossy. It's
  // safe to leave the reminder alone: the cron cancels a reminder whose item is
  // soft-deleted once the reminder comes due (app/api/cron/reminders/route.ts),
  // and the digest skips items with no live reminders, so nothing ever fires
  // for a row that stays cleared.
  return NextResponse.json({
    cleared: (cleared || []).length,
    clearedIds: (cleared || []).map((i) => i.id),
  });
}
