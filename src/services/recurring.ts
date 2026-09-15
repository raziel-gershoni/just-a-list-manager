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
  //    This closes the CONCURRENT-invocation paths — a replayed client mutation,
  //    a stale Telegram button, or a second recipient of a shared reminder, each
  //    racing a completion that is already in flight. A time-window check cannot
  //    do even this much: it reads and then writes, so two callers can both read
  //    "not completed" first.
  //
  //    It does not close every double-invocation path: the claim's key is
  //    `items.completed`, a mutable bit. Anything that flips it back to false
  //    re-arms the claim — a manual un-tick, `recycleItem`, or the 4-hour
  //    respawn window in useListData.ts. Nothing cancels a reminder on Done, so
  //    a later, stale Telegram tap can still win the claim and mint a second
  //    successor. See the design spec's Scope "Out" section.
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
    // Release the claim so a retry can heal this. Without it the retry's CAS
    // loses, the route answers 200 already-completed, the queue dequeues it as
    // a success, and the series ends silently with every layer reporting OK.
    await supabase
      .from("items")
      .update({ completed: false, completed_at: null })
      .eq("id", itemId)
      .eq("completed", true);
    return { status: "error" };
  }

  // 5. Create reminder on the new item. Failure here is logged, not surfaced as
  // an error: the item is already completed and a successor already exists, so
  // returning "error" would re-create the exact trap this function just closed
  // (a retry's CAS would lose and silently report success). The cost of this
  // path is an occurrence that never fires, not a dead series.
  const { error: reminderError } = await supabase.from("item_reminders").insert({
    item_id: newItem.id,
    list_id: listId,
    created_by: userId,
    remind_at: nextRemindAt.toISOString(),
    is_shared: isShared,
    recurrence,
  });
  if (reminderError) {
    console.error("[Recurring] Failed to create reminder for new item:", newItem.id, reminderError);
  }

  return {
    status: "created",
    newItemId: newItem.id,
    nextRemindAt: nextRemindAt.toISOString(),
  };
}
