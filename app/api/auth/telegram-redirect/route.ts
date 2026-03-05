import { NextResponse } from "next/server";

export async function GET() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!botToken || !appUrl) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const botId = botToken.split(":")[0];
  const origin = new URL(appUrl).origin;
  const callbackUrl = `${origin}/api/auth/telegram-login-callback`;

  const telegramOAuthUrl = `https://oauth.telegram.org/auth?bot_id=${botId}&origin=${encodeURIComponent(origin)}&return_to=${encodeURIComponent(callbackUrl)}`;

  return NextResponse.redirect(telegramOAuthUrl, 302);
}
