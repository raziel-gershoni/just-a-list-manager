import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { dbError } from "@/src/lib/api-errors";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { unmarkCompletedSchema } from "@/src/schemas/items";

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

  const body = await readJsonBody(request, "items/unmark-completed/POST");
  const parsed = parseBody(unmarkCompletedSchema, body);
  if (!parsed.success) return parsed.response;

  const supabase = createServerClient();

  // Flip the completed items the user saw back to active (non-destructive). Scoping to their
  // ids means an item ticked by a collaborator a moment ago is never unmarked.
  const { data: unmarked, error } = await supabase
    .from("items")
    .update({ completed: false, completed_at: null })
    .in("id", parsed.data.itemIds)
    .eq("list_id", listId)
    .eq("completed", true)
    .is("deleted_at", null)
    .select("id");

  if (error) return dbError("items/unmark-completed/POST", "Unmark completed", error, { listId });

  return NextResponse.json({
    unmarked: (unmarked || []).length,
    unmarkedIds: (unmarked || []).map((i) => i.id),
  });
}
