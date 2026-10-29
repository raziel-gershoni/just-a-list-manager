import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { dbError } from "@/src/lib/api-errors";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { clearCompletedSchema } from "@/src/schemas/items";

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

  const body = await readJsonBody(request, "items/clear-completed/POST");
  const parsed = parseBody(clearCompletedSchema, body);
  if (!parsed.success) return parsed.response;

  const supabase = createServerClient();

  // Soft-delete the completed items the user saw (for undo support). Scoping to their ids
  // means an item ticked by a collaborator a moment ago, or one the user unticked while
  // that change is still queued, is never cleared. Recurring staples are
  // excluded: they stay parked in the Recurring drawer on their completion
  // clock rather than being retired — delete-is-final vetoes respawn on
  // deleted_at (src/utils/recurring-respawn.ts), so soft-deleting a parked
  // recurring row here would destroy it permanently instead of just clearing
  // it. See docs/superpowers/specs/2026-09-08-delete-is-final-design.md.
  const { data: cleared, error } = await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", parsed.data.itemIds)
    .eq("list_id", listId)
    .eq("completed", true)
    .eq("recurring", false)
    .is("deleted_at", null)
    .select("id");

  if (error) return dbError("items/clear-completed/POST", "Clear completed", error, { listId });

  return NextResponse.json({
    cleared: (cleared || []).length,
    clearedIds: (cleared || []).map((i) => i.id),
  });
}
