import { NextRequest, NextResponse } from "next/server";
import { validateInitData } from "@/src/lib/telegram-auth";
import { createServerClient } from "@/src/lib/supabase";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";

export async function GET(request: NextRequest) {
  const initData = request.headers.get("x-telegram-init-data");

  if (!initData) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimitResult = await checkRateLimit(apiRateLimiter, telegramUser.id);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
    );
  }

  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(user);
}

export async function POST(request: NextRequest) {
  const initData = request.headers.get("x-telegram-init-data");

  if (!initData) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimitResult = await checkRateLimit(apiRateLimiter, telegramUser.id);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
    );
  }

  const supabase = createServerClient();
  const name = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ");

  // Check if user already exists
  const { data: existing } = await supabase
    .from("users")
    .select()
    .eq("telegram_id", telegramUser.id)
    .single();

  if (existing) {
    // Existing user: update name/username but preserve their stored language
    const { data: user, error } = await supabase
      .from("users")
      .update({
        name,
        username: telegramUser.username || null,
      })
      .eq("telegram_id", telegramUser.id)
      .select()
      .single();

    if (error) {
      console.error("[User] Update error:", error);
      return NextResponse.json(
        { error: "Failed to update user" },
        { status: 500 }
      );
    }
    return NextResponse.json(user);
  }

  // New user: set language from Telegram's language_code
  const language = ["en", "he", "ru"].includes(telegramUser.language_code || "")
    ? telegramUser.language_code
    : "en";

  const { data: user, error } = await supabase
    .from("users")
    .insert({
      telegram_id: telegramUser.id,
      name,
      username: telegramUser.username || null,
      language,
    })
    .select()
    .single();

  if (error) {
    console.error("[User] Insert error:", error);
    return NextResponse.json(
      { error: "Failed to register user" },
      { status: 500 }
    );
  }

  return NextResponse.json(user);
}

export async function PATCH(request: NextRequest) {
  const initData = request.headers.get("x-telegram-init-data");

  if (!initData) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const updates: Record<string, any> = {};

  if (body.language && ["en", "he", "ru"].includes(body.language)) {
    updates.language = body.language;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .update(updates)
    .eq("telegram_id", telegramUser.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json(user);
}
