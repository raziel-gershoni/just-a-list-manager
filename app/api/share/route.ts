import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { verifyUserAuth, verifyListPermission } from "@/src/lib/api-auth";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { createServerClient } from "@/src/lib/supabase";

const BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME!;

export async function GET(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "share-get");
  if (!auth.success) return auth.response;

  const { searchParams } = new URL(request.url);
  const listId = searchParams.get("listId");

  if (!listId) {
    return NextResponse.json({ error: "Missing listId" }, { status: 400 });
  }

  // Only owner can view share settings
  const perm = await verifyListPermission(auth.userId, listId, "view");
  if (!perm.allowed || perm.role !== "owner") {
    return NextResponse.json(
      { error: "Only the list owner can view share settings" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();

  // Get collaborators
  const { data: collaborators } = await supabase
    .from("collaborators")
    .select("id, user_id, permission, status, users(name, username)")
    .eq("list_id", listId);

  // Get active invite link
  const { data: activeLinks } = await supabase
    .from("invite_links")
    .select("token, permission, expires_at")
    .eq("list_id", listId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  const activeLink = activeLinks?.[0]
    ? `https://t.me/${BOT_USERNAME}?start=invite_${activeLinks[0].token}`
    : null;

  return NextResponse.json({
    collaborators: collaborators || [],
    activeLink,
  });
}

export async function POST(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "share-create");
  if (!auth.success) return auth.response;

  const body = await request.json();
  const { listId, permission = "edit" } = body;

  if (!listId) {
    return NextResponse.json({ error: "Missing listId" }, { status: 400 });
  }

  // Only owner can generate invite links
  const perm = await verifyListPermission(auth.userId, listId, "edit");
  if (!perm.allowed || perm.role !== "owner") {
    return NextResponse.json(
      { error: "Only the list owner can generate invite links" },
      { status: 403 }
    );
  }

  const supabase = createServerClient();
  const token = nanoid(21);
  const expiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error } = await supabase.from("invite_links").insert({
    list_id: listId,
    token,
    permission: permission === "view" ? "view" : "edit",
    expires_at: expiresAt,
    created_by: auth.userId,
  });

  if (error) {
    console.error("[Share] Create invite error:", error);
    return NextResponse.json(
      { error: "Failed to create invite" },
      { status: 500 }
    );
  }

  const link = `https://t.me/${BOT_USERNAME}?start=invite_${token}`;
  return NextResponse.json({ token, link, expiresAt }, { status: 201 });
}
