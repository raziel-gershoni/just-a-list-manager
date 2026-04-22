import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { completeRecurringItem } from "@/src/services/recurring";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id: listId, itemId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "complete-recurring");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to edit this list" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { remindAt, recurrence, isShared } = body as {
    remindAt: string;
    recurrence: string;
    isShared: boolean;
  };

  if (!remindAt || !recurrence) {
    return NextResponse.json({ error: "remindAt and recurrence required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Get item text
  const { data: item } = await supabase
    .from("items")
    .select("text")
    .eq("id", itemId)
    .eq("list_id", listId)
    .single();

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const result = await completeRecurringItem(supabase, {
    itemId,
    listId,
    userId: auth.userId,
    text: item.text,
    remindAt,
    recurrence,
    isShared: isShared ?? false,
  });

  if (!result) {
    return NextResponse.json({ error: "Failed to create next occurrence" }, { status: 500 });
  }

  return NextResponse.json(result, { status: 201 });
}
