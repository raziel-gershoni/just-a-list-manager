import { NextRequest } from "next/server";
import { validateLoginWidget } from "@/src/lib/telegram-auth";
import { createServerClient } from "@/src/lib/supabase";
import { signToken } from "@/src/lib/jwt";
import {
  authIpRateLimiter,
  authUserRateLimiter,
  checkRateLimit,
} from "@/src/lib/rate-limit";

export async function GET(request: NextRequest) {
  // Tier 1: IP-based rate limit
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipRateLimit = await checkRateLimit(authIpRateLimiter, ip);
  if (!ipRateLimit.success) {
    return redirectToLogin("rate-limit");
  }

  // Extract query params as Record<string, string>
  const params: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const telegramUser = validateLoginWidget(params);
  if (!telegramUser) {
    return redirectToLogin("auth");
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
    return redirectToLogin("server");
  }

  // Tier 2: Per-user rate limit
  const userRateLimit = await checkRateLimit(authUserRateLimiter, user.id);
  if (!userRateLimit.success) {
    return redirectToLogin("rate-limit");
  }

  const token = await signToken(user.id, user.telegram_id);

  // Return HTML that stores the token and redirects to home
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
localStorage.setItem('web_auth_token','${token}');
window.location.href='/';
</script></body></html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

function redirectToLogin(error: string) {
  return Response.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL || ""}/login?error=${error}`,
    302
  );
}
