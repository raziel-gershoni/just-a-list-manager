import { NextRequest, NextResponse } from "next/server";
import { validateInitData } from "@/src/lib/telegram-auth";
import { createServerClient } from "@/src/lib/supabase";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Auth check
  const initData =
    request.headers.get("x-telegram-init-data") ||
    new URL(request.url).searchParams.get("initData");

  if (!initData) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 5 req/min per user
  const rateLimitResult = await checkRateLimit(apiRateLimiter, telegramUser.id);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
    );
  }

  const supabase = createServerClient();

  // Validate invite link
  const { data: invite } = await supabase
    .from("invite_links")
    .select("id, list_id, permission, expires_at, revoked_at")
    .eq("token", token)
    .single();

  if (!invite) {
    return NextResponse.json(
      { error: "Invite not found" },
      { status: 404 }
    );
  }

  if (invite.revoked_at || new Date(invite.expires_at) < new Date()) {
    return NextResponse.json(
      { error: "This invite link has expired or been revoked." },
      { status: 410 }
    );
  }

  // Get the list
  const { data: list } = await supabase
    .from("lists")
    .select("id, name, owner_id")
    .eq("id", invite.list_id)
    .is("deleted_at", null)
    .single();

  if (!list) {
    return NextResponse.json(
      { error: "This list has been deleted." },
      { status: 410 }
    );
  }

  // Look up or create user
  const name = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ");
  const language = ["en", "he", "ru"].includes(
    telegramUser.language_code || ""
  )
    ? telegramUser.language_code
    : "en";

  const { data: user } = await supabase
    .from("users")
    .upsert(
      {
        telegram_id: telegramUser.id,
        name,
        username: telegramUser.username || null,
        language,
      },
      { onConflict: "telegram_id" }
    )
    .select("id")
    .single();

  if (!user) {
    return NextResponse.json(
      { error: "Failed to register user" },
      { status: 500 }
    );
  }

  // Check if user is the owner
  if (list.owner_id === user.id) {
    return NextResponse.json(
      { error: "You already own this list", status: "already_approved", listId: list.id },
      { status: 400 }
    );
  }

  // Check existing collaborator status
  const { data: existing } = await supabase
    .from("collaborators")
    .select("id, status")
    .eq("list_id", list.id)
    .eq("user_id", user.id)
    .single();

  if (existing) {
    if (existing.status === "approved") {
      return NextResponse.json(
        {
          status: "already_approved",
          listId: list.id,
        },
        { status: 400 }
      );
    }
    if (existing.status === "pending") {
      return NextResponse.json(
        {
          status: "already_pending",
          listId: list.id,
          listName: list.name,
          collaboratorId: existing.id,
        },
        { status: 400 }
      );
    }
    // Re-invite declined user
    await supabase
      .from("collaborators")
      .update({
        status: "pending",
        permission: invite.permission,
      })
      .eq("id", existing.id);

    // Send approval request to owner
    await sendApprovalNotification(
      supabase,
      list.owner_id,
      user.id,
      name,
      list.id,
      list.name,
      existing.id
    );

    return NextResponse.json({
      listId: list.id,
      listName: list.name,
      collaboratorId: existing.id,
      status: "pending",
    });
  }

  // Check max pending collaborators (10 per list)
  const { count: pendingCount } = await supabase
    .from("collaborators")
    .select("id", { count: "exact", head: true })
    .eq("list_id", list.id)
    .eq("status", "pending");

  if ((pendingCount || 0) >= 10) {
    return NextResponse.json(
      { error: "Too many pending requests for this list" },
      { status: 400 }
    );
  }

  // Create pending collaborator
  const { data: collab, error } = await supabase
    .from("collaborators")
    .insert({
      list_id: list.id,
      user_id: user.id,
      permission: invite.permission,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Share] Accept invite error:", error);
    return NextResponse.json(
      { error: "Failed to process invite" },
      { status: 500 }
    );
  }

  // Send approval request to owner
  await sendApprovalNotification(
    supabase,
    list.owner_id,
    user.id,
    name,
    list.id,
    list.name,
    collab!.id
  );

  return NextResponse.json({
    listId: list.id,
    listName: list.name,
    collaboratorId: collab!.id,
    status: "pending",
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const initData = request.headers.get("x-telegram-init-data");
  if (!initData) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const collaboratorId = searchParams.get("collaboratorId");

  if (!collaboratorId) {
    return NextResponse.json(
      { error: "Missing collaboratorId" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Verify the collaborator belongs to this user
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await supabase
    .from("collaborators")
    .delete()
    .eq("id", collaboratorId)
    .eq("user_id", user.id)
    .eq("status", "pending");

  return NextResponse.json({ success: true });
}

async function sendApprovalNotification(
  supabase: any,
  ownerId: string,
  requesterId: string,
  requesterName: string,
  listId: string,
  listName: string,
  collaboratorId: string
) {
  try {
    // Get owner's telegram_id
    const { data: owner } = await supabase
      .from("users")
      .select("telegram_id, language")
      .eq("id", ownerId)
      .single();

    if (owner) {
      const { sendApprovalRequest } = await import("@/src/services/bot");
      await sendApprovalRequest(
        owner.telegram_id,
        requesterId,
        requesterName,
        listId,
        listName,
        collaboratorId,
        owner.language
      );
    }
  } catch (e) {
    console.error("[Share] Failed to send approval notification:", e);
  }
}
