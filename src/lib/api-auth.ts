/**
 * API Authentication Middleware
 * Common auth and rate limiting patterns for user-authenticated routes
 */

import { NextRequest, NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { jwtVerify } from "jose";
import { z } from "zod";
import { validateInitData } from "./telegram-auth";
import { checkRateLimit, getRateLimitHeaders } from "./rate-limit";
import { createServerClient } from "./supabase";
import { getJwtSecret } from "./jwt";
import { dbError } from "./api-errors";

export interface DbUser {
  id: string; // UUID
  telegram_id: number;
  name: string;
  username: string | null;
  language: string;
}

export type AuthResult =
  | { success: true; userId: string; telegramUserId: number; user?: DbUser }
  | { success: false; response: NextResponse };

/**
 * Verify user authentication and check rate limits.
 * Dual-path auth: JWT Bearer preferred, initData fallback.
 * JWT path skips DB lookup (userId from token claims).
 * initData path does full DB lookup for backward compatibility.
 */
export async function verifyUserAuth(
  request: NextRequest,
  rateLimiter: Ratelimit,
  endpointName: string
): Promise<AuthResult> {
  // Path 1: JWT Bearer token (preferred — 1h expiry vs initData's 5min)
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const { payload } = await jwtVerify(token, getJwtSecret());
      const userId = payload.sub as string;
      const telegramUserId = payload.telegram_user_id as number;

      if (!userId || !telegramUserId) {
        return {
          success: false,
          response: NextResponse.json(
            { error: "Invalid token claims" },
            { status: 401 }
          ),
        };
      }

      // Rate limit by telegram user ID (consistent with initData path)
      const rateLimitResult = await checkRateLimit(rateLimiter, telegramUserId);
      if (!rateLimitResult.success) {
        return {
          success: false,
          response: NextResponse.json(
            { error: "Too many requests. Please wait a minute." },
            { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
          ),
        };
      }

      return { success: true, userId, telegramUserId };
    } catch (err) {
      console.warn(`[${endpointName}] JWT verification failed:`, err);
      return {
        success: false,
        response: NextResponse.json(
          { error: "Invalid or expired token" },
          { status: 401 }
        ),
      };
    }
  }

  // Path 2: initData fallback (header only — avoids credential leakage via logs/referrers)
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

  // Look up user in DB. maybeSingle: no row is a user who never opened the app (404);
  // an error is a failed read, answered 500 so it is never mistaken for a missing user.
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, telegram_id, name, username, language")
    .eq("telegram_id", telegramUser.id)
    .maybeSingle();

  if (error) {
    return {
      success: false,
      response: dbError(endpointName, "User lookup", error, { telegramUserId: telegramUser.id }),
    };
  }

  if (!user) {
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
    telegramUserId: telegramUser.id,
    user: user as DbUser,
  };
}

const listIdSchema = z.string().uuid();

/**
 * Check if a user has the required permission level on a list.
 * A failed read is logged and thrown, so the route answers 500 (which the offline queue
 * retries) instead of a false 403 (which it drops). A missing row is a plain "not allowed".
 * A list id that is not a uuid (a stale deep link) is denied without a database call: the
 * database would reject it as a malformed uuid, which is not a failure worth retrying.
 */
export async function verifyListPermission(
  userId: string,
  listId: string,
  requiredPermission: "view" | "edit"
): Promise<{ allowed: boolean; role: "owner" | "editor" | "viewer" | null }> {
  if (!listIdSchema.safeParse(listId).success) {
    return { allowed: false, role: null };
  }

  const supabase = createServerClient();

  // Check if user is owner
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("owner_id")
    .eq("id", listId)
    .is("deleted_at", null)
    .maybeSingle();

  if (listError) {
    console.error("[Permission] List read failed:", { userId, listId }, listError);
    throw new Error("Permission check failed", { cause: listError });
  }

  if (!list) {
    return { allowed: false, role: null };
  }

  if (list.owner_id === userId) {
    return { allowed: true, role: "owner" };
  }

  // Check collaborator status
  const { data: collab, error: collabError } = await supabase
    .from("collaborators")
    .select("permission, status")
    .eq("list_id", listId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .maybeSingle();

  if (collabError) {
    console.error("[Permission] Collaborator read failed:", { userId, listId }, collabError);
    throw new Error("Permission check failed", { cause: collabError });
  }

  if (!collab) {
    return { allowed: false, role: null };
  }

  const role = collab.permission === "edit" ? "editor" : "viewer";

  if (requiredPermission === "edit" && collab.permission === "view") {
    return { allowed: false, role };
  }

  return { allowed: true, role };
}
