import { isInitDataFresh } from "@/src/hooks/useJWTRefresh";

/** What the invite page shows after asking to join a list. */
export type JoinOutcome =
  | { kind: "pending"; listId: string; listName: string; collaboratorId: string }
  | { kind: "member"; listId: string }
  | { kind: "invalid"; message: string }
  | { kind: "retry" };

/**
 * The credential for asking to join: the launch initData while the server still accepts it
 * (a Telegram "Reload page" reuses it long after), else the session JWT. Null with neither.
 */
export function inviteAuthHeaders(initData: string | null, jwt: string | null): Record<string, string> | null {
  if (initData && isInitDataFresh(initData)) return { "x-telegram-init-data": initData };
  if (jwt) return { Authorization: `Bearer ${jwt}` };
  return null;
}

/**
 * Asks to join the list behind an invite link. A server failure (5xx), a rate limit (429), a
 * refused sign-in (401) or a dropped connection is "retry": the link may be fine. Only the
 * route's own refusals (404, 410, 400) are "invalid". The token is in the URL, so it is never
 * logged.
 */
export async function requestToJoin(token: string, authHeaders: Record<string, string>): Promise<JoinOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/share/${token}`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.warn("[Invite] Join request did not reach the server:", err);
    return { kind: "retry" };
  }

  if (res.status >= 500 || res.status === 429) {
    console.error("[Invite] Join request failed, status:", res.status);
    return { kind: "retry" };
  }
  if (res.status === 401) {
    console.warn("[Invite] Join request was refused sign-in, status:", res.status);
    return { kind: "retry" };
  }

  let data: { status?: string; listId?: string; listName?: string; collaboratorId?: string; error?: string };
  try {
    data = await res.json();
  } catch (err) {
    console.error("[Invite] Join response was not JSON, status:", res.status, err);
    return { kind: "retry" };
  }

  if (res.ok || data.status === "already_pending") {
    return {
      kind: "pending",
      listId: data.listId || "",
      listName: data.listName || "",
      collaboratorId: data.collaboratorId || "",
    };
  }
  if (data.status === "already_approved" && data.listId) {
    return { kind: "member", listId: data.listId };
  }
  return { kind: "invalid", message: data.error || "This invite is no longer valid." };
}

/** Withdraws a pending join request. True only when the server confirmed it. */
export async function cancelJoinRequest(
  token: string,
  collaboratorId: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetch(`/api/share/${token}?collaboratorId=${collaboratorId}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      console.error("[Invite] Cancel join request failed, collaboratorId:", collaboratorId, "status:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Invite] Failed to cancel join request, collaboratorId:", collaboratorId, err);
    return false;
  }
}
