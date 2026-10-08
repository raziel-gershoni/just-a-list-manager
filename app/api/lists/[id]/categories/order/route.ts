import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { categoryOrderSchema } from "@/src/schemas/categories";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: listId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "categories-order");
  if (!auth.success) return auth.response;
  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json({ error: "You don't have permission to edit this list" }, { status: 403 });
  }

  const parsed = parseBody(categoryOrderSchema, await request.json().catch(() => null));
  if (!parsed.success) return parsed.response;
  const { orderedIds } = parsed.data;

  // One statement under the list row lock; false (nothing written) unless the order names
  // every category of this list exactly once.
  const { data: applied, error } = await createServerClient().rpc("reorder_list_categories", {
    p_list_id: listId,
    p_ordered_ids: orderedIds,
  });
  if (error) return NextResponse.json({ error: "Failed to reorder" }, { status: 500 });
  if (!applied) {
    return NextResponse.json({ error: "Order must list every category of this list once" }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}
