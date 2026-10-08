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

  const supabase = createServerClient();
  const { data } = await supabase.from("list_categories").select("id").eq("list_id", listId);
  const current = new Set(((data ?? []) as { id: string }[]).map((c) => c.id));
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length || given.size !== current.size || orderedIds.some((id) => !current.has(id))) {
    return NextResponse.json({ error: "Order must list every category of this list once" }, { status: 400 });
  }

  for (const [position, id] of orderedIds.entries()) {
    const { error } = await supabase
      .from("list_categories")
      .update({ position })
      .eq("id", id)
      .eq("list_id", listId);
    if (error) return NextResponse.json({ error: "Failed to reorder" }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
