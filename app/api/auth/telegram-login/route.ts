import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  verifyAndExtractUser,
} from "@/src/lib/telegram-oauth";
import { createServerClient } from "@/src/lib/supabase";
import { signToken } from "@/src/lib/jwt";
import {
  authIpRateLimiter,
  authUserRateLimiter,
  checkRateLimit,
  getRateLimitHeaders,
} from "@/src/lib/rate-limit";

export async function POST(request: NextRequest) {
  // Tier 1: IP-based rate limit
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipRateLimit = await checkRateLimit(authIpRateLimiter, ip);
  if (!ipRateLimit.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429, headers: getRateLimitHeaders(ipRateLimit) }
    );
  }

  let body: { code?: string; code_verifier?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { code, code_verifier } = body;
  if (!code || !code_verifier) {
    return NextResponse.json(
      { error: "Missing code or code_verifier" },
      { status: 400 }
    );
  }

  let telegramUser;
  try {
    const tokens = await exchangeCodeForTokens(code, code_verifier);
    telegramUser = await verifyAndExtractUser(tokens.id_token, tokens.access_token);
  } catch (error) {
    console.error("[TelegramOAuth] Token exchange/verification failed:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 401 }
    );
  }

  // Upsert user (same pattern as app/api/auth/token/route.ts)
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .upsert(
      {
        telegram_id: telegramUser.telegramId,
        name: telegramUser.name,
        username: telegramUser.username,
      },
      { onConflict: "telegram_id" }
    )
    .select("id, telegram_id")
    .single();

  if (error || !user) {
    console.error("[TelegramOAuth] User upsert error:", error);
    return NextResponse.json(
      { error: "Failed to register user" },
      { status: 500 }
    );
  }

  // Tier 2: Per-user rate limit
  const userRateLimit = await checkRateLimit(authUserRateLimiter, user.id);
  if (!userRateLimit.success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429, headers: getRateLimitHeaders(userRateLimit) }
    );
  }

  const token = await signToken(user.id, user.telegram_id);
  return NextResponse.json({ token });
}
