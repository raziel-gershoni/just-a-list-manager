import type { SupabaseClient } from "@supabase/supabase-js";

export type JoinedUser = { id: string; telegram_id: number | null; language: string | null };
export type Recipient = { telegramId: number; language: string };

// Supabase to-one embeds — owner via lists.owner_id, user via collaborators.user_id —
// return a SINGLE OBJECT per row, not an array. Access `.users` directly (NOT `.users[0]`).
// Same embed is read as an object in src/services/bot.ts and components/ShareDialog.tsx.
type OwnerRow = { users: JoinedUser | null } | null;
type CollaboratorRow = { users: JoinedUser | null };

/** Pure: flatten owner + collaborator query rows into a flat candidate user list. */
export function candidatesFromRows(
  ownerRow: OwnerRow,
  collabRows: CollaboratorRow[] | null
): (JoinedUser | null)[] {
  const owner = ownerRow?.users ?? null;
  const collabUsers = (collabRows ?? []).map((c) => c.users ?? null);
  return [owner, ...collabUsers];
}

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

  const candidates = candidatesFromRows(
    listWithOwner as unknown as OwnerRow,
    collaborators as unknown as CollaboratorRow[] | null
  );

  return buildRecipientList(candidates, senderUserId);
}
