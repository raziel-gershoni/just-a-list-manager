/**
 * Telegram OAuth 2.0 (OIDC + PKCE) — server-side helpers
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { serverEnv } from "@/src/lib/env";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const DISCOVERY_URL =
  "https://oauth.telegram.org/.well-known/openid-configuration";

interface OIDCConfig {
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

let _oidcConfig: OIDCConfig | null = null;
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getOIDCConfig(): Promise<OIDCConfig> {
  if (_oidcConfig) return _oidcConfig;
  const res = await fetch(DISCOVERY_URL);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (${res.status}): ${await res.text().then((t) => t.slice(0, 200))}`
    );
  }
  const data = await res.json();
  _oidcConfig = {
    token_endpoint: data.token_endpoint,
    userinfo_endpoint: data.userinfo_endpoint,
    jwks_uri: data.jwks_uri,
  };
  return _oidcConfig;
}

async function getJWKS() {
  if (_jwks) return _jwks;
  const config = await getOIDCConfig();
  _jwks = createRemoteJWKSet(new URL(config.jwks_uri));
  return _jwks;
}

/** Parse a fetch response as JSON, with a clear error if the body is HTML. */
async function parseJsonResponse(
  response: Response,
  label: string
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const body = await response.text();
    throw new Error(
      `${label}: expected JSON but got ${contentType || "no content-type"}. ` +
        `Status ${response.status}. Body: ${body.slice(0, 300)}`
    );
  }
  return response.json();
}

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
  const config = await getOIDCConfig();
  const credentials = btoa(
    `${env.TELEGRAM_OAUTH_CLIENT_ID}:${env.TELEGRAM_OAUTH_CLIENT_SECRET}`
  );

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await parseJsonResponse(response, "Token exchange");
  return data as unknown as TokenResponse;
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
  const jwks = await getJWKS();

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: TELEGRAM_ISSUER,
    audience: env.TELEGRAM_OAUTH_CLIENT_ID,
  });

  // Log all id_token claims so we can see what Telegram actually provides
  console.log(
    "[TelegramOAuth] id_token claims:",
    JSON.stringify(payload, null, 2)
  );

  // Strategy 1: Look for a numeric Telegram user ID in id_token custom claims
  let telegramId = extractTelegramId(payload);

  // Strategy 2: Try the OIDC userinfo endpoint
  if (!telegramId) {
    const config = await getOIDCConfig();
    try {
      const userinfoRes = await fetch(config.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const contentType = userinfoRes.headers.get("content-type") || "";
      if (userinfoRes.ok && contentType.includes("json")) {
        const userinfo = await userinfoRes.json();
        console.log(
          "[TelegramOAuth] userinfo response:",
          JSON.stringify(userinfo, null, 2)
        );
        telegramId = extractTelegramId(userinfo);
      } else {
        console.warn(
          `[TelegramOAuth] userinfo returned non-JSON (${userinfoRes.status}, ${contentType})`
        );
      }
    } catch (err) {
      console.warn("[TelegramOAuth] userinfo fetch failed:", err);
    }
  }

  if (!telegramId) {
    throw new Error(
      "Could not determine Telegram user ID from OAuth. " +
        `id_token claims: ${JSON.stringify(payload)}`
    );
  }

  return {
    telegramId,
    name: (payload.name as string) || "Unknown",
    username:
      (payload.preferred_username as string) ||
      (payload.username as string) ||
      null,
    picture:
      (payload.picture as string) || (payload.photo_url as string) || null,
  };
}

/** Try to extract a valid numeric Telegram user ID from a set of claims. */
function extractTelegramId(
  claims: Record<string, unknown>
): number | undefined {
  // Check known claim names that might hold the numeric Telegram ID
  for (const key of ["id", "telegram_id", "user_id"]) {
    const val = claims[key];
    if (val !== undefined) {
      const num = Number(val);
      if (!isNaN(num) && num > 0 && num <= Number.MAX_SAFE_INTEGER) {
        return num;
      }
    }
  }

  // Fall back to `sub` if it looks like a reasonable Telegram user ID
  const sub = claims.sub;
  if (sub !== undefined) {
    const num = Number(sub);
    if (!isNaN(num) && num > 0 && num <= Number.MAX_SAFE_INTEGER) {
      return num;
    }
  }

  return undefined;
}
