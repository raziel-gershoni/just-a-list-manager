import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { reorderListsSchema } from "@/src/schemas/lists";
import { parseBody } from "@/src/lib/api-validation";
import { buildListOrderRows } from "@/src/utils/list-order";

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-reorder");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const parsed = parseBody(reorderListsSchema, body);
  if (!parsed.success) return parsed.response;

  const orderedIds: string[] = parsed.data.orderedIds;
  const supabase = createServerClient();

  // Deliberately NOT verifyListPermission(..., "edit"): reordering your own
  // home screen is not editing anyone's list, so a view-only collaborator
  // may reorder. Instead, filter down to lists this user can actually see —
  // the same visibility rule GET /api/lists uses.
  const [{ data: owned }, { data: collab }] = await Promise.all([
    supabase
      .from("lists")
      .select("id")
      .eq("owner_id", auth.userId)
      .is("deleted_at", null)
      .in("id", orderedIds),
    supabase
      .from("collaborators")
      .select("list_id")
      .eq("user_id", auth.userId)
      .eq("status", "approved")
      .in("list_id", orderedIds),
  ]);

  const visible = new Set<string>([
    ...(owned || []).map((l) => l.id),
    ...(collab || []).map((c) => c.list_id),
  ]);

  // Ids the caller cannot see are dropped silently rather than 4xx'd — a list
  // deleted concurrently in another tab must not fail the whole reorder.
  const allowedIds = orderedIds.filter((id) => visible.has(id));
  if (allowedIds.length === 0) {
    return NextResponse.json({ updated: 0 });
  }

  // One statement, not N parallel updates: a partial reorder is never
  // observable.
  const rows = buildListOrderRows(auth.userId, allowedIds);
  const { error } = await supabase
    .from("list_order")
    .upsert(rows, { onConflict: "user_id,list_id" });

  if (error) {
    console.error("[lists-reorder] Upsert failed:", error);
    return NextResponse.json(
      { error: "Failed to save list order" },
      { status: 500 }
    );
  }

  return NextResponse.json({ updated: rows.length });
}
