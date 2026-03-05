import { SignJWT } from "jose";

export const JWT_SECRET = new TextEncoder().encode(
  process.env.SUPABASE_JWT_SECRET!
);
export const JWT_EXPIRY = "1h";

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
    .sign(JWT_SECRET);
}
