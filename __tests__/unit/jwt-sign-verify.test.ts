import { describe, it, expect, vi } from "vitest";
import { SignJWT, jwtVerify } from "jose";

vi.mock("@/src/lib/env", () => ({
  serverEnv: () => ({ SUPABASE_JWT_SECRET: "test-secret-for-jose" }),
}));

import { signToken, getJwtSecret } from "@/src/lib/jwt";

// The same tolerance the token refresh route passes to jwtVerify (app/api/auth/token/route.ts).
const REFRESH_TOLERANCE = 604800;
const DAY = 86400;
const claims = { sub: "u1", aud: "authenticated", role: "authenticated", iss: "supabase", telegram_user_id: 123 };

const signAt = (iat: number, exp: number, secret = getJwtSecret()) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secret);

describe("tokens signed and verified with the real jose", () => {
  it("signToken makes an HS256 token that verifies, with the app's claims and a 7 day life", async () => {
    const token = await signToken("u1", 123);
    const { payload, protectedHeader } = await jwtVerify(token, getJwtSecret());
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload).toMatchObject({ sub: "u1", aud: "authenticated", role: "authenticated", iss: "supabase", telegram_user_id: 123 });
    expect(payload.exp! - payload.iat!).toBe(7 * DAY);
  });

  it("refuses an expired token, and the refresh tolerance takes it back only within 7 days", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredYesterday = await signAt(now - 8 * DAY, now - DAY);
    await expect(jwtVerify(expiredYesterday, getJwtSecret())).rejects.toMatchObject({ code: "ERR_JWT_EXPIRED" });
    await expect(jwtVerify(expiredYesterday, getJwtSecret(), { clockTolerance: REFRESH_TOLERANCE })).resolves.toBeTruthy();

    const expiredLongAgo = await signAt(now - 20 * DAY, now - 10 * DAY);
    await expect(jwtVerify(expiredLongAgo, getJwtSecret(), { clockTolerance: REFRESH_TOLERANCE })).rejects.toMatchObject({
      code: "ERR_JWT_EXPIRED",
    });
  });

  it("refuses a token signed with another secret", async () => {
    const token = await signToken("u1", 123);
    await expect(jwtVerify(token, new TextEncoder().encode("another-secret"))).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });

  it("refuses an unsigned alg:none token", async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "none" })}.${part({ ...claims, exp: Math.floor(Date.now() / 1000) + DAY })}.`;
    await expect(jwtVerify(unsigned, getJwtSecret())).rejects.toBeTruthy();
  });
});
