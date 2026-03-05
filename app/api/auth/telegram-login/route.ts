import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createServerClient } from "@/src/lib/supabase";
import { signToken } from "@/src/lib/jwt";
import {
  authIpRateLimiter,
  authUserRateLimiter,
  checkRateLimit,
  getRateLimitHeaders,
} from "@/src/lib/rate-limit";

const JWKS = createRemoteJWKSet(
  new URL("https://oauth.telegram.org/.well-known/jwks.json")
);

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

  let body: { id_token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.id_token) {
    return NextResponse.json({ error: "Missing id_token" }, { status: 400 });
  }

  // Validate id_token JWT from Telegram
  const botId = process.env.TELEGRAM_BOT_TOKEN?.split(":")[0];
  if (!botId) {
    console.error("[Auth] TELEGRAM_BOT_TOKEN not configured");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  let payload;
  try {
    const result = await jwtVerify(body.id_token, JWKS, {
      issuer: "https://oauth.telegram.org",
      audience: botId,
    });
    payload = result.payload;
  } catch (err) {
    console.warn("[Auth] JWT verification failed:", err);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramId = Number(payload.sub);
  if (!telegramId) {
    return NextResponse.json({ error: "Invalid token payload" }, { status: 401 });
  }

  const name = (payload.name as string) || "";
  const username = (payload.preferred_username as string) || null;

  // Upsert user to ensure they exist
  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .upsert(
      {
        telegram_id: telegramId,
        name,
        username,
      },
      { onConflict: "telegram_id" }
    )
    .select("id, telegram_id")
    .single();

  if (error || !user) {
    console.error("[Auth] User upsert error:", error);
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
