import type { SupabaseClient } from "@supabase/supabase-js";

export function getNextOccurrence(remindAt: Date, recurrence: string): Date {
  const next = new Date(remindAt);
  const now = new Date();
  const advance = () => {
    switch (recurrence) {
      case "weekly": next.setDate(next.getDate() + 7); break;
      case "monthly": next.setMonth(next.getMonth() + 1); break;
      default: next.setDate(next.getDate() + 1); // daily + fallback
    }
  };
  while (next <= now) advance();
  return next;
}

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
): Promise<{ newItemId: string; nextRemindAt: string } | null> {
  const { itemId, listId, userId, text, remindAt, recurrence, isShared } = params;

  // 1. Mark original item completed
  await supabase
    .from("items")
    .update({ completed: true, completed_at: new Date().toISOString() })
    .eq("id", itemId);

  // 2. Calculate next occurrence
  const nextRemindAt = getNextOccurrence(new Date(remindAt), recurrence);

  // 3. Create new item with same text
  const { data: newItem, error: createError } = await supabase
    .from("items")
    .insert({ text, list_id: listId, created_by: userId, position: Date.now() })
    .select("id")
    .single();

  if (createError || !newItem) {
    console.error("[Recurring] Failed to create new item:", createError);
    return null;
  }

  // 4. Create reminder on the new item
  await supabase.from("item_reminders").insert({
    item_id: newItem.id,
    list_id: listId,
    created_by: userId,
    remind_at: nextRemindAt.toISOString(),
    is_shared: isShared,
    recurrence,
  });

  return { newItemId: newItem.id, nextRemindAt: nextRemindAt.toISOString() };
}
