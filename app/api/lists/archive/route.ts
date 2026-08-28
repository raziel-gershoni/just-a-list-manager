import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { archiveListSchema } from "@/src/schemas/lists";
import { parseBody } from "@/src/lib/api-validation";

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "lists-archive");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const parsed = parseBody(archiveListSchema, body);
  if (!parsed.success) return parsed.response;

  const { listId, archived } = parsed.data;
  const supabase = createServerClient();

  // Archive is per-user, so this is NOT verifyListPermission(..., "edit") — a
  // view-only collaborator must be able to archive a shared list off their own
  // home screen. Gate on visibility instead, the same rule GET /api/lists uses.
  const [
    { data: owned, error: ownedError },
    { data: collab, error: collabError },
  ] = await Promise.all([
    supabase
      .from("lists")
      .select("id")
      .eq("id", listId)
      .eq("owner_id", auth.userId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("collaborators")
      .select("list_id")
      .eq("list_id", listId)
      .eq("user_id", auth.userId)
      .eq("status", "approved")
      .maybeSingle(),
  ]);

  // postgrest-js resolves rather than rejects on failure, so an unchecked
  // error would read as "this user cannot see the list" and 404 wrongly.
  if (ownedError || collabError) {
    console.error("[lists-archive] Visibility query failed:", ownedError || collabError);
    return NextResponse.json({ error: "Failed to update list" }, { status: 500 });
  }

  if (!owned && !collab) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  // Only archived_at is supplied, so an existing manual position is preserved.
  const { error } = await supabase.from("user_list_state").upsert(
    {
      user_id: auth.userId,
      list_id: listId,
      archived_at: archived ? new Date().toISOString() : null,
    },
    { onConflict: "user_id,list_id" }
  );

  if (error) {
    console.error("[lists-archive] Upsert failed:", error);
    return NextResponse.json({ error: "Failed to update list" }, { status: 500 });
  }

  return NextResponse.json({ archived });
}
