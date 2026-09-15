import type { SupabaseClient } from "@supabase/supabase-js";

export function getNextOccurrence(remindAt: Date, recurrence: string): Date {
  // Advance at least once: if user is marking done, the current occurrence is acknowledged,
  // so the next reminder must be a future occurrence (not the same one).
  const next = new Date(remindAt);
  const now = new Date();
  const advance = () => {
    switch (recurrence) {
      case "weekly": next.setDate(next.getDate() + 7); break;
      case "monthly": next.setMonth(next.getMonth() + 1); break;
      default: next.setDate(next.getDate() + 1); // daily + fallback
    }
  };
  do { advance(); } while (next <= now);
  return next;
}

export type CompleteRecurringOutcome =
  | { status: "created"; newItemId: string; nextRemindAt: string }
  | { status: "already-completed" }
  | { status: "error" };

export async function completeRecurringItem(
  supabase: SupabaseClient,
  params: {
    itemId: string;
    listId: string;
    userId: string;
    text: string;
    remindAt: string;
    recurrence: string;
    isShared: boolean;
  }
): Promise<CompleteRecurringOutcome> {
  const { itemId, listId, userId, text, remindAt, recurrence, isShared } = params;

  // 1. Claim the occurrence. This single-statement compare-and-swap IS the
  //    idempotency guard: under READ COMMITTED a concurrent second UPDATE blocks
  //    on the row lock, then re-evaluates `completed = false` against the committed
  //    version and matches zero rows. Exactly one caller gets a row back; the loser
  //    returns without creating anything.
  //
  //    This is what stops one Done tap producing two occurrences — whether the
  //    repeat comes from a replayed client mutation, a stale Telegram button, or a
  //    second recipient of a shared reminder. A time-window check cannot: it reads
  //    and then writes, so two callers can both read "not completed" first.
  //
  //    `deleted_at IS NULL` keeps this consistent with the delete-is-final rule —
  //    a deleted item never spawns a successor.
  const { data: claimed, error: claimError } = await supabase
    .from("items")
    .update({ completed: true, completed_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("completed", false)
    .is("deleted_at", null)
    .select("id");

  if (claimError) {
    console.error("[Recurring] Claim failed:", claimError);
    return { status: "error" };
  }
  if (!claimed || claimed.length === 0) {
    return { status: "already-completed" };
  }

  // 2. Soft-delete previous completed occurrences (same text, same list, not the current item)
  await supabase
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("list_id", listId)
    .eq("text", text)
    .eq("completed", true)
    .neq("id", itemId)
    .is("deleted_at", null);

  // 3. Calculate next occurrence
  const nextRemindAt = getNextOccurrence(new Date(remindAt), recurrence);

  // 4. Create new item with same text
  const { data: newItem, error: createError } = await supabase
    .from("items")
    .insert({ text, list_id: listId, created_by: userId, position: Date.now() })
    .select("id")
    .single();

  if (createError || !newItem) {
    console.error("[Recurring] Failed to create new item:", createError);
    return { status: "error" };
  }

  // 5. Create reminder on the new item
  await supabase.from("item_reminders").insert({
    item_id: newItem.id,
    list_id: listId,
    created_by: userId,
    remind_at: nextRemindAt.toISOString(),
    is_shared: isShared,
    recurrence,
  });

  return {
    status: "created",
    newItemId: newItem.id,
    nextRemindAt: nextRemindAt.toISOString(),
  };
}
