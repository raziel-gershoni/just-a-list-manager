// READ-ONLY audit: are there item_reminders rows whose list_id disagrees with
// their item's list_id?
//
// item_reminders.item_id and .list_id are independent FKs (migration 014) and
// nothing bound them until the check added to the reminder-create route. A
// mismatched row lets its creator read another list's item text via the
// reminder message and the digest. No feature moves an item between lists, so
// a mismatch has no benign producer.
//
// Run: node scripts/audit-reminder-list-binding.mjs
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// PostgREST cannot compare two columns across an embed, so pull the pairs and
// compare in JS. Volume is small (one row per reminder ever created).
const { data: rows, error } = await sb
  .from('item_reminders')
  .select('id, item_id, list_id, created_by, created_at, cancelled_at, sent_at, items!inner(list_id)');

if (error) { console.error('query failed:', error); process.exit(1); }

const mismatched = (rows ?? []).filter((r) => {
  const item = r.items;
  return item && item.list_id !== r.list_id;
});

console.log(`scanned ${rows?.length ?? 0} item_reminders rows`);

if (!mismatched.length) {
  console.log('\nNo mismatched rows. The laundering hole was never exercised.');
  process.exit(0);
}

console.log(`\n*** ${mismatched.length} MISMATCHED ROW(S) — each is a live cross-list read channel ***\n`);
for (const r of mismatched) {
  console.log(`  reminder ${r.id}`);
  console.log(`    created_at=${r.created_at}  created_by=${r.created_by}`);
  console.log(`    reminder.list_id=${r.list_id}`);
  console.log(`    item.list_id    =${r.items.list_id}   <-- disagrees`);
  console.log(`    sent=${r.sent_at ?? '-'}  cancelled=${r.cancelled_at ?? '-'}`);
}
console.log('\nThese predate the reminder-create binding check and are not healed by it.');
process.exit(2);
