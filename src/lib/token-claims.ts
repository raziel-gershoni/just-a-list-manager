/** The claims of the app's own JWT (src/lib/jwt.ts) that the client reads. Not verified: the server does that. */
export function readTokenClaims(token: string): { iat?: number; telegram_user_id?: number } | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload));
  } catch (err) {
    console.warn("[Auth] Unreadable token claims:", err);
    return null;
  }
}
