import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "items-reorder");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const orderedIds: string[] = body.orderedIds;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json(
      { error: "orderedIds must be a non-empty array" },
      { status: 400 }
    );
  }

  // Filter out temp IDs (optimistic items not yet persisted)
  const realIds = orderedIds.filter((id) => !id.startsWith("temp-"));
  if (realIds.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  const supabase = createServerClient();

  // Assign positions: first item (top) gets highest position, last gets 1
  const updates = realIds.map((id, index) => {
    const position = realIds.length - index;
    return supabase
      .from("items")
      .update({ position })
      .eq("id", id)
      .eq("list_id", listId);
  });

  const results = await Promise.all(updates);
  const errors = results.filter((r) => r.error);

  if (errors.length > 0) {
    console.error("[reorder] Errors:", errors.map((e) => e.error));
    return NextResponse.json(
      { error: "Some items failed to update" },
      { status: 500 }
    );
  }

  return NextResponse.json({ updated: realIds.length });
}
