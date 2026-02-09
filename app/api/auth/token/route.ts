import { NextRequest, NextResponse } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { validateInitData } from "@/src/lib/telegram-auth";
import { createServerClient } from "@/src/lib/supabase";

const JWT_SECRET = new TextEncoder().encode(
  process.env.SUPABASE_JWT_SECRET!
);
const JWT_EXPIRY = "1h";

async function signToken(userId: string, telegramId: number): Promise<string> {
  return new SignJWT({
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iss: "supabase",
    telegram_user_id: telegramId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET);
}

export async function GET(request: NextRequest) {
  // Path 1: Refresh via existing JWT
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const existingToken = authHeader.slice(7);
    try {
      // Accept tokens within 10-minute grace period past expiry
      const { payload } = await jwtVerify(existingToken, JWT_SECRET, {
        clockTolerance: 600, // 10 minutes
      });

      const userId = payload.sub as string;
      const telegramId = payload.telegram_user_id as number;

      if (!userId || !telegramId) {
        return NextResponse.json(
          { error: "Invalid token claims" },
          { status: 401 }
        );
      }

      const token = await signToken(userId, telegramId);
      return NextResponse.json({ token });
    } catch {
      return NextResponse.json(
        { error: "Token expired. Please reopen the app." },
        { status: 401 }
      );
    }
  }

  // Path 2: Initial token via initData (header only)
  const initData = request.headers.get("x-telegram-init-data");

  if (!initData) {
    return NextResponse.json(
      { error: "Missing authentication" },
      { status: 401 }
    );
  }

  const telegramUser = validateInitData(initData);
  if (!telegramUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Upsert user to ensure they exist
  const supabase = createServerClient();
  const name = [telegramUser.first_name, telegramUser.last_name]
    .filter(Boolean)
    .join(" ");
  const language = ["en", "he", "ru"].includes(
    telegramUser.language_code || ""
  )
    ? telegramUser.language_code
    : "en";

  const { data: user, error } = await supabase
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
    .select("id, telegram_id")
    .single();

  if (error || !user) {
    console.error("[Auth] User upsert error:", error);
    return NextResponse.json(
      { error: "Failed to register user" },
      { status: 500 }
    );
  }

  const token = await signToken(user.id, user.telegram_id);
  return NextResponse.json({ token });
}
