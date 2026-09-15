// One-off cleanup for the duplicate created by the 2026-09-07 double-invocation
// race (fixed on main by the compare-and-swap claim in src/services/recurring.ts).
//
// Two identical successor rows were created 29ms apart. This soft-deletes the
// LOSER (the one created second) and cancels its reminder — exactly what the
// app's own DELETE endpoint does (app/api/lists/[id]/items/route.ts DELETE +
// cancelItemReminders). Deletion is final as of 2026-09-08, so the 7-day purge
// cron removes it permanently.
//
// Dry run (default):  node scripts/cleanup-lehem-duplicate.mjs
// Apply:              node scripts/cleanup-lehem-duplicate.mjs --apply
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const KEEP = '9b2edb6b';   // created 2026-09-07T04:02:27.843417 — the winner
const DROP = '26240c02';   // created 2026-09-07T04:02:27.872669 — the race loser
const EXPECTED_TEXT = 'לתזכר לקוחות לגבי לחם';

const apply = process.argv.includes('--apply');

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Resolve both rows by prefix, so a wrong id can never be acted on silently.
const { data: rows, error } = await sb
  .from('items')
  .select('id, list_id, text, completed, deleted_at, created_at')
  .ilike('text', EXPECTED_TEXT)
  .is('deleted_at', null);
if (error) { console.error('lookup failed:', error); process.exit(1); }

const keep = (rows ?? []).find((r) => r.id.startsWith(KEEP));
const drop = (rows ?? []).find((r) => r.id.startsWith(DROP));

// Preconditions — refuse to act unless the state still matches the diagnosis.
const problems = [];
if (!keep) problems.push(`the row to KEEP (${KEEP}…) is not present and active`);
if (!drop) problems.push(`the row to DROP (${DROP}…) is not present and active`);
if (drop && drop.completed) problems.push('the row to DROP is completed — state has changed since diagnosis');
if (keep && drop && keep.list_id !== drop.list_id) problems.push('the two rows are in different lists');
if (keep && drop && keep.text !== drop.text) problems.push('the two rows no longer have identical text');
if (keep && drop && new Date(drop.created_at) <= new Date(keep.created_at)) {
  problems.push('the row to DROP is not the later of the two — refusing to guess');
}

console.log(`active rows with this text: ${rows?.length ?? 0}`);
for (const r of rows ?? []) {
  const tag = r.id.startsWith(DROP) ? 'DROP' : r.id.startsWith(KEEP) ? 'KEEP' : '????';
  console.log(`  [${tag}] ${r.id}  created=${r.created_at}  completed=${r.completed}`);
}

if (problems.length) {
  console.error('\nREFUSING TO ACT — preconditions not met:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRe-run scripts/diagnose-reminder-dupes.mjs and re-check before forcing anything.');
  process.exit(1);
}

const { data: rems } = await sb
  .from('item_reminders')
  .select('id, remind_at, recurrence, sent_at, cancelled_at')
  .eq('item_id', drop.id)
  .is('cancelled_at', null);

console.log(`\nwould soft-delete item ${drop.id}`);
console.log(`would cancel ${rems?.length ?? 0} uncancelled reminder(s) on it:`);
for (const m of rems ?? []) {
  console.log(`  ${m.id}  remind_at=${m.remind_at}  recurrence=${m.recurrence ?? '-'}  sent=${m.sent_at ?? '-'}`);
}
console.log(`keeping ${keep.id}`);

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to perform it.');
  process.exit(0);
}

const now = new Date().toISOString();

const { error: delErr } = await sb
  .from('items')
  .update({ deleted_at: now })
  .eq('id', drop.id)
  .is('deleted_at', null);
if (delErr) { console.error('soft-delete failed:', delErr); process.exit(1); }

const { error: remErr } = await sb
  .from('item_reminders')
  .update({ cancelled_at: now })
  .eq('item_id', drop.id)
  .is('cancelled_at', null);
if (remErr) { console.error('reminder cancel failed:', remErr); process.exit(1); }

console.log(`\nDONE. Soft-deleted ${drop.id} and cancelled its reminders at ${now}.`);
console.log('The 7-day purge cron will remove it permanently.');
