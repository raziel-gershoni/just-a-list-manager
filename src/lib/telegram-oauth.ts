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
  idToken: string
): Promise<TelegramOAuthUser> {
  const env = serverEnv();

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: TELEGRAM_ISSUER,
    audience: env.TELEGRAM_OAUTH_CLIENT_ID,
  });

  const telegramId = Number(payload.sub);
  if (!telegramId || isNaN(telegramId)) {
    throw new Error("Invalid sub claim in id_token");
  }

  return {
    telegramId,
    name: (payload.name as string) || "Unknown",
    username: (payload.preferred_username as string) || null,
    picture: (payload.picture as string) || null,
  };
}
