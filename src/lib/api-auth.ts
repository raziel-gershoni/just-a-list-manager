/**
 * API Authentication Middleware
 * Common auth and rate limiting patterns for user-authenticated routes
 */

import { NextRequest, NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { validateInitData, TelegramUser } from "./telegram-auth";
import { checkRateLimit, getRateLimitHeaders } from "./rate-limit";
import { createServerClient } from "./supabase";

export interface DbUser {
  id: string; // UUID
  telegram_id: number;
  name: string;
  username: string | null;
  language: string;
}

export type AuthResult =
  | { success: true; userId: string; telegramUser: TelegramUser; user: DbUser }
  | { success: false; response: NextResponse };

/**
 * Verify user authentication and check rate limits.
 * Extracts initData from Authorization header or query param,
 * validates Telegram auth, checks rate limit, looks up DB user.
 */
export async function verifyUserAuth(
  request: NextRequest,
  rateLimiter: Ratelimit,
  endpointName: string
): Promise<AuthResult> {
  // Extract initData from header only (never from query params — avoids credential leakage via logs/referrers)
  const initData = request.headers.get("x-telegram-init-data");

  if (!initData) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "Missing authentication" },
        { status: 401 }
      ),
    };
  }

  // Validate Telegram initData
  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    console.warn(`[${endpointName}] Invalid initData`);
    return {
      success: false,
      response: NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }

  // Check rate limits
  const rateLimitResult = await checkRateLimit(
    rateLimiter,
    telegramUser.id
  );
  if (!rateLimitResult.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      ),
    };
  }

  // Look up user in DB
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, telegram_id, name, username, language")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (error || !user) {
    console.warn(`[${endpointName}] User not found: ${telegramUser.id}`);
    return {
      success: false,
      response: NextResponse.json(
        { error: "User not found. Please open the app first." },
        { status: 404 }
      ),
    };
  }

  return {
    success: true,
    userId: user.id,
    telegramUser,
    user: user as DbUser,
  };
}

/**
 * Check if a user has the required permission level on a list.
 */
export async function verifyListPermission(
  userId: string,
  listId: string,
  requiredPermission: "view" | "edit"
): Promise<{ allowed: boolean; role: "owner" | "editor" | "viewer" | null }> {
  const supabase = createServerClient();

  // Check if user is owner
  const { data: list } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", listId)
    .is("deleted_at", null)
    .single();

  if (!list) {
    return { allowed: false, role: null };
  }

  if (list.owner_id === userId) {
    return { allowed: true, role: "owner" };
  }

  // Check collaborator status
  const { data: collab } = await supabase
    .from("collaborators")
    .select("permission, status")
    .eq("list_id", listId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .single();

  if (!collab) {
    return { allowed: false, role: null };
  }

  const role = collab.permission === "edit" ? "editor" : "viewer";

  if (requiredPermission === "edit" && collab.permission === "view") {
    return { allowed: false, role };
  }

  return { allowed: true, role };
}
