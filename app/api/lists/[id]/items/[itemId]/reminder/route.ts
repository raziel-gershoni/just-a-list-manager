import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";
import { parseBody } from "@/src/lib/api-validation";
import { createReminderSchema } from "@/src/schemas/reminders";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id: listId, itemId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "reminder-create");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to access this list" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const parsed = parseBody(createReminderSchema, body);
  if (!parsed.success) return parsed.response;

  const remindAt = new Date(parsed.data.remind_at);
  const now = new Date();
  const fiveMinFromNow = new Date(now.getTime() + 5 * 60 * 1000);
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  if (remindAt < fiveMinFromNow) {
    return NextResponse.json(
      { error: "Reminder must be at least 5 minutes in the future" },
      { status: 400 }
    );
  }

  if (remindAt > oneYearFromNow) {
    return NextResponse.json(
      { error: "Reminder must be within 1 year" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Check max 5 active reminders per item per user
  const { count } = await supabase
    .from("item_reminders")
    .select("id", { count: "exact", head: true })
    .eq("item_id", itemId)
    .eq("created_by", auth.userId)
    .is("sent_at", null)
    .is("cancelled_at", null);

  if ((count ?? 0) >= 5) {
    return NextResponse.json(
      { error: "Maximum 5 active reminders per item" },
      { status: 400 }
    );
  }

  const { data: reminder, error } = await supabase
    .from("item_reminders")
    .insert({
      item_id: itemId,
      list_id: listId,
      created_by: auth.userId,
      remind_at: parsed.data.remind_at,
      is_shared: parsed.data.is_shared,
      recurrence: parsed.data.recurrence ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("[Reminder] Insert error:", error);
    return NextResponse.json(
      { error: "Failed to create reminder" },
      { status: 500 }
    );
  }

  return NextResponse.json(reminder, { status: 201 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id: listId, itemId } = await params;
  const auth = await verifyUserAuth(request, apiRateLimiter, "reminder-list");
  if (!auth.success) return auth.response;

  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed) {
    return NextResponse.json(
      { error: "You don't have permission to access this list" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  const { data: reminders, error } = await supabase
    .from("item_reminders")
    .select("*")
    .eq("item_id", itemId)
    .eq("created_by", auth.userId)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .order("remind_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch reminders" },
      { status: 500 }
    );
  }

  return NextResponse.json(reminders);
}
