import { SignJWT } from "jose";
import { serverEnv } from "@/src/lib/env";

let _jwtSecret: Uint8Array | null = null;

export function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    _jwtSecret = new TextEncoder().encode(serverEnv().SUPABASE_JWT_SECRET);
  }
  return _jwtSecret;
}

export const JWT_EXPIRY = "7d";

// How long past expiry the token refresh route still accepts a token, in seconds (7 days).
export const REFRESH_TOLERANCE_SECONDS = 604800;

export async function signToken(
  userId: string,
  telegramId: number
): Promise<string> {
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
    .sign(getJwtSecret());
}
