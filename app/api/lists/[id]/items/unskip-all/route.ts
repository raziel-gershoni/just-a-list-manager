import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { unskipAllSchema } from "@/src/schemas/items";
import { parseBody } from "@/src/lib/api-validation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-unskip-all");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const parsed = parseBody(unskipAllSchema, await request.json().catch(() => null));
  if (!parsed.success) return parsed.response;

  const supabase = createServerClient();

  // Return the Not available items the user saw to the active list. Scoping to their
  // ids means a late or replayed request can't restore anything skipped after the tap.
  // Only skipped_at is written, so no completed/deleted filter is needed: an item ticked
  // off or deleted meanwhile just loses a stale skip. Positions are kept.
  const { data: restored, error } = await supabase
    .from("items")
    .update({ skipped_at: null })
    .in("id", parsed.data.itemIds)
    .eq("list_id", listId)
    .not("skipped_at", "is", null)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to restore items" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    restored: (restored || []).length,
    restoredIds: (restored || []).map((i) => i.id),
  });
}
