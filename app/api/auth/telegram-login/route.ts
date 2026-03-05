import { NextRequest, NextResponse } from "next/server";
import { validateLoginWidget } from "@/src/lib/telegram-auth";
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

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const telegramUser = validateLoginWidget(body);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Upsert user to ensure they exist
  const supabase = createServerClient();
  const name = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ");

  const { data: user, error } = await supabase
    .from("users")
    .upsert(
      {
        telegram_id: telegramUser.id,
        name,
        username: telegramUser.username || null,
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
