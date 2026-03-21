/**
 * Telegram OAuth 2.0 (OIDC + PKCE) — server-side helpers
 *
 * Per https://core.telegram.org/bots/telegram-login:
 * - Token endpoint: https://oauth.telegram.org/token
 * - JWKS: https://oauth.telegram.org/.well-known/jwks.json
 * - No userinfo endpoint — all user data is in the id_token
 * - The `id` claim holds the numeric Telegram user ID (not `sub`)
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { serverEnv } from "@/src/lib/env";

const TELEGRAM_TOKEN_URL = "https://oauth.telegram.org/token";
const TELEGRAM_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
const TELEGRAM_ISSUER = "https://oauth.telegram.org";

const jwks = createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL));

export function getRedirectUri(): string {
  return `${serverEnv().NEXT_PUBLIC_APP_URL}/login/callback`;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const env = serverEnv();
  const credentials = btoa(
    `${env.TELEGRAM_OAUTH_CLIENT_ID}:${env.TELEGRAM_OAUTH_CLIENT_SECRET}`
  );

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.TELEGRAM_OAUTH_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    code_verifier: codeVerifier,
  });

  const response = await fetch(TELEGRAM_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token exchange failed (${response.status}): ${text.slice(0, 300)}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const text = await response.text();
    throw new Error(
      `Token exchange: expected JSON but got ${contentType}. Body: ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<TokenResponse>;
}

export interface TelegramOAuthUser {
  telegramId: number;
  name: string;
  username: string | null;
  picture: string | null;
}

export async function verifyAndExtractUser(
  idToken: string
): Promise<TelegramOAuthUser> {
  const env = serverEnv();

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: TELEGRAM_ISSUER,
    audience: env.TELEGRAM_OAUTH_CLIENT_ID,
  });

  // Per Telegram docs, the numeric Telegram user ID is in the `id` claim (as a string)
  const telegramId = Number(payload.id);
  if (!telegramId || isNaN(telegramId)) {
    throw new Error(
      `Missing 'id' claim in id_token. Claims: ${JSON.stringify(payload)}`
    );
  }

  return {
    telegramId,
    name: (payload.name as string) || "Unknown",
    username: (payload.preferred_username as string) || null,
    picture: (payload.picture as string) || null,
  };
}
