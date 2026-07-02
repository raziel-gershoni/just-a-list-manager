import type { SupabaseClient } from "@supabase/supabase-js";

export type JoinedUser = { id: string; telegram_id: number | null; language: string | null };
export type Recipient = { telegramId: number; language: string };

/**
 * Pure: turn a flat candidate list into send targets.
 * Drops the sender, null entries, and users without a telegram_id; dedupes by user id.
 */
export function buildRecipientList(
  candidates: (JoinedUser | null)[],
  senderUserId: string
): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const u of candidates) {
    if (!u || u.id === senderUserId || !u.telegram_id) continue;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({ telegramId: u.telegram_id, language: u.language || "en" });
  }
  return out;
}

/** Fetch owner + approved collaborators for a list and build the recipient list (sender excluded). */
export async function resolveListRecipients(
  supabase: SupabaseClient,
  listId: string,
  senderUserId: string
): Promise<Recipient[]> {
  const { data: listWithOwner } = await supabase
    .from("lists")
    .select("owner_id, users!lists_owner_id_fkey(id, telegram_id, language)")
    .eq("id", listId)
    .single();

  const { data: collaborators } = await supabase
    .from("collaborators")
    .select("user_id, users!collaborators_user_id_fkey(id, telegram_id, language)")
    .eq("list_id", listId)
    .eq("status", "approved");

  const owner = (listWithOwner as { users: JoinedUser | null } | null)?.users ?? null;
  const collabUsers = (collaborators ?? []).map(
    (c) => (c as unknown as { users: JoinedUser[] | null }).users?.[0] ?? null
  );

  return buildRecipientList([owner, ...collabUsers], senderUserId);
}
