import { NextRequest, NextResponse } from "next/server";
import { validateInitData } from "@/src/lib/telegram-auth";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { createServerClient } from "@/src/lib/supabase";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";
import { dbError } from "@/src/lib/api-errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Auth check (header only — avoids credential leakage via logs/referrers)
  const initData = request.headers.get("x-telegram-init-data");

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

  // Validate invite link. The token is a credential: never put it in a log line.
  const { data: invite, error: inviteError } = await supabase
    .from("invite_links")
    .select("id, list_id, permission, expires_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  if (inviteError) return dbError("Share", "Invite read", inviteError);
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
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("id, name, owner_id")
    .eq("id", invite.list_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (listError) return dbError("Share", "List read", listError, { listId: invite.list_id });
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

  const { data: user, error: userError } = await supabase
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

  if (userError || !user) {
    return dbError("Share", "User upsert", userError, { telegramId: telegramUser.id });
  }

  // Check if user is the owner
  if (list.owner_id === user.id) {
    return NextResponse.json(
      { error: "You already own this list", status: "already_approved", listId: list.id },
      { status: 400 }
    );
  }

  // Check existing collaborator status
  const { data: existing, error: existingError } = await supabase
    .from("collaborators")
    .select("id, status")
    .eq("list_id", list.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingError) {
    return dbError("Share", "Collaborator read", existingError, { listId: list.id, userId: user.id });
  }
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
    const { error: reinviteError } = await supabase
      .from("collaborators")
      .update({
        status: "pending",
        permission: invite.permission,
      })
      .eq("id", existing.id);

    if (reinviteError) {
      return dbError("Share", "Re-invite update", reinviteError, { collaboratorId: existing.id });
    }

    // Send approval request to owner. The request is saved either way, so the
    // invitee still sees "pending" and the owner finds it in the Share dialog.
    const notified = await sendApprovalNotification(
      supabase,
      list.owner_id,
      user.id,
      name,
      list.id,
      list.name,
      existing.id
    );
    if (!notified) {
      console.warn("[Share] Owner was not notified of the join request:", { listId: list.id, collaboratorId: existing.id });
    }

    return NextResponse.json({
      listId: list.id,
      listName: list.name,
      collaboratorId: existing.id,
      status: "pending",
    });
  }

  // Check max pending collaborators (10 per list)
  const { count: pendingCount, error: countError } = await supabase
    .from("collaborators")
    .select("id", { count: "exact", head: true })
    .eq("list_id", list.id)
    .eq("status", "pending");

  // Fail closed: the cap must not be bypassed because the count could not be read.
  if (countError) return dbError("Share", "Pending count read", countError, { listId: list.id });

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

  if (error || !collab) {
    console.error("[Share] Accept invite error:", { listId: list.id, userId: user.id }, error);
    return NextResponse.json(
      { error: "Failed to process invite" },
      { status: 500 }
    );
  }

  // Send approval request to owner (see the re-invite branch above)
  const notified = await sendApprovalNotification(
    supabase,
    list.owner_id,
    user.id,
    name,
    list.id,
    list.name,
    collab.id
  );
  if (!notified) {
    console.warn("[Share] Owner was not notified of the join request:", { listId: list.id, collaboratorId: collab.id });
  }

  return NextResponse.json({
    listId: list.id,
    listName: list.name,
    collaboratorId: collab.id,
    status: "pending",
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "share-cancel");
  if (!auth.success) return auth.response;

  const { searchParams } = new URL(request.url);
  const collaboratorId = searchParams.get("collaboratorId");

  if (!collaboratorId) {
    return NextResponse.json(
      { error: "Missing collaboratorId" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // Zero matched rows is still success: the request is already gone.
  const { error } = await supabase
    .from("collaborators")
    .delete()
    .eq("id", collaboratorId)
    .eq("user_id", auth.userId)
    .eq("status", "pending");

  if (error) {
    return dbError("Share", "Join request cancel", error, { collaboratorId, userId: auth.userId });
  }

  return NextResponse.json({ success: true });
}

/** Messages the list owner about a join request. True only when the owner was actually messaged. */
async function sendApprovalNotification(
  supabase: ReturnType<typeof createServerClient>,
  ownerId: string,
  requesterId: string,
  requesterName: string,
  listId: string,
  listName: string,
  collaboratorId: string
): Promise<boolean> {
  try {
    // Get owner's telegram_id
    const { data: owner, error: ownerError } = await supabase
      .from("users")
      .select("telegram_id, language")
      .eq("id", ownerId)
      .maybeSingle();

    if (ownerError) {
      console.error("[Share] Owner read failed:", { ownerId }, ownerError);
      return false;
    }
    if (!owner) {
      console.warn("[Share] List owner row is missing:", { ownerId });
      return false;
    }

    const { sendApprovalRequest } = await import("@/src/services/bot");
    return await sendApprovalRequest(
      owner.telegram_id,
      requesterId,
      requesterName,
      listId,
      listName,
      collaboratorId,
      owner.language
    );
  } catch (e) {
    console.error("[Share] Failed to send approval notification:", e);
    return false;
  }
}
