import type { SupabaseClient } from "@supabase/supabase-js";

export async function cancelItemReminders(
  supabase: SupabaseClient,
  itemIds: string | string[]
) {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
  if (ids.length === 0) return;

  await supabase
    .from("item_reminders")
    .update({ cancelled_at: new Date().toISOString() })
    .in("item_id", ids)
    .is("cancelled_at", null);
}
