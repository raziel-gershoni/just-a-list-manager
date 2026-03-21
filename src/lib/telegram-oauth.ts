/**
 * Telegram OAuth 2.0 (OIDC + PKCE) — server-side helpers
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
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

export interface TelegramOAuthUser {
  telegramId: number;
  name: string;
  username: string | null;
  picture: string | null;
}

export async function verifyAndExtractUser(
  idToken: string,
  accessToken: string
): Promise<TelegramOAuthUser> {
  const env = serverEnv();

  // Verify the id_token signature and claims
  await jwtVerify(idToken, jwks, {
    issuer: TELEGRAM_ISSUER,
    audience: env.TELEGRAM_OAUTH_CLIENT_ID,
  });

  // Fetch user profile from the userinfo endpoint to get the actual Telegram user ID
  // (the id_token `sub` is an opaque OIDC identifier, not the numeric Telegram ID)
  const userinfoRes = await fetch("https://oauth.telegram.org/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userinfoRes.ok) {
    const text = await userinfoRes.text();
    throw new Error(`Userinfo request failed (${userinfoRes.status}): ${text}`);
  }

  const userinfo = await userinfoRes.json();

  // The numeric Telegram user ID may be in `id` or `telegram_id`
  const rawId = userinfo.id ?? userinfo.telegram_id;
  const telegramId = Number(rawId);
  if (!telegramId || isNaN(telegramId) || telegramId > Number.MAX_SAFE_INTEGER) {
    console.error("[TelegramOAuth] Could not extract Telegram user ID from userinfo:", JSON.stringify(userinfo));
    throw new Error("Could not determine Telegram user ID from OAuth profile");
  }

  return {
    telegramId,
    name: (userinfo.name as string) || "Unknown",
    username: (userinfo.preferred_username as string) || (userinfo.username as string) || null,
    picture: (userinfo.picture as string) || (userinfo.photo_url as string) || null,
  };
}
