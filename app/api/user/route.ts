import { NextRequest, NextResponse } from "next/server";
import { validateInitData } from "@/src/lib/telegram-auth";
import { verifyUserAuth } from "@/src/lib/api-auth";
import { createServerClient } from "@/src/lib/supabase";
import { apiRateLimiter } from "@/src/lib/rate-limit";
import { checkRateLimit, getRateLimitHeaders } from "@/src/lib/rate-limit";
import { updateUserSchema } from "@/src/schemas/user";
import { parseBody, readJsonBody } from "@/src/lib/api-validation";
import { dbError } from "@/src/lib/api-errors";

export async function GET(request: NextRequest) {
  const auth = await verifyUserAuth(request, apiRateLimiter, "user-get");
  if (!auth.success) return auth.response;

  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", auth.userId)
    .maybeSingle();

  if (error) return dbError("user/GET", "User read", error, { userId: auth.userId });
  if (!user) {
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

  // Check if user already exists. maybeSingle: no row is the normal new-user answer, so
  // `error` is a real failure and must not fall through to an INSERT.
  const { data: existing, error: lookupError } = await supabase
    .from("users")
    .select()
    .eq("telegram_id", telegramUser.id)
    .maybeSingle();
  if (lookupError) return dbError("user/POST", "User lookup", lookupError, { telegramId: telegramUser.id });

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
  const auth = await verifyUserAuth(request, apiRateLimiter, "user-update");
  if (!auth.success) return auth.response;

  const body = await readJsonBody(request, "user/PATCH");
  const parsed = parseBody(updateUserSchema, body);
  if (!parsed.success) return parsed.response;

  const updates: Record<string, string> = {};
  if (parsed.data.language) updates.language = parsed.data.language;

  const supabase = createServerClient();
  const { data: user, error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", auth.userId)
    .select()
    .single();

  if (error) return dbError("user/PATCH", "Update", error, { userId: auth.userId });

  return NextResponse.json(user);
}
