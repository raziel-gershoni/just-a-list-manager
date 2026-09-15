// READ-ONLY diagnostic for duplicate items in reminders lists.
// No writes, no DDL. Run:  node scripts/diagnose-reminder-dupes.mjs
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

const { data: lists, error: le } = await sb
  .from('lists')
  .select('id, name, type')
  .eq('type', 'reminders')
  .is('deleted_at', null);
if (le) { console.error('lists error:', le); process.exit(1); }
if (!lists?.length) { console.log('no reminders lists'); process.exit(0); }

for (const list of lists) {
  const { data: items, error: ie } = await sb
    .from('items')
    .select('id, text, completed, completed_at, deleted_at, created_by, created_at, updated_at, position')
    .eq('list_id', list.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (ie) { console.error('items error:', ie); continue; }

  // shared fan-out only matters if the list actually has other members
  const { count: collabCount } = await sb
    .from('collaborators')
    .select('user_id', { count: 'exact', head: true })
    .eq('list_id', list.id)
    .eq('status', 'approved');

  // Group by case-folded text. A real duplicate is two or more rows that are BOTH
  // live — uncompleted and undeleted. A completed parent sitting next to its live
  // successor is normal recurring succession, not a duplicate; counting those was
  // an early version of this script's own bug and it reported 8 false positives.
  const groups = new Map();
  for (const i of items) {
    const k = i.text.toLocaleLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const dupes = [...groups.entries()].filter(
    ([, v]) => v.filter((i) => !i.completed).length > 1
  );
  if (!dupes.length) { console.log(`\n=== ${list.name}: no active duplicates ===`); continue; }

  console.log(`\n=== ${list.name} (${list.id}) — ${dupes.length} duplicated text(s), ${collabCount ?? 0} approved collaborator(s) ===`);

  for (const [, rows] of dupes) {
    console.log(`\n  TEXT: ${JSON.stringify(rows[0].text)}  (${rows.filter((r) => !r.completed).length} LIVE rows, ${rows.length} total incl. completed)`);
    const ids = rows.map((r) => r.id);
    const { data: rems } = await sb
      .from('item_reminders')
      .select('id, item_id, remind_at, recurrence, is_shared, sent_at, cancelled_at, created_at, created_by')
      .in('item_id', ids)
      .order('created_at', { ascending: true });

    for (const r of rows) {
      // updated_at ≫ created_at means the row was mutated after birth (recycled / un-ticked),
      // which separates the "resurrection" causes from the "ran twice" causes.
      const touched = r.updated_at && new Date(r.updated_at) - new Date(r.created_at) > 2000;
      console.log(`   item ${r.id.slice(0, 8)}  created=${r.created_at}  updated=${r.updated_at ?? '-'}${touched ? '  <-- MUTATED AFTER BIRTH' : ''}`);
      console.log(`      completed=${r.completed} completed_at=${r.completed_at ?? '-'}  by=${(r.created_by ?? '-').toString().slice(0, 8)}  position=${r.position}`);
      for (const m of (rems ?? []).filter((x) => x.item_id === r.id)) {
        console.log(`      reminder ${m.id.slice(0, 8)}  created=${m.created_at}  remind_at=${m.remind_at}  recurrence=${m.recurrence ?? '-'}  sent=${m.sent_at ?? '-'}  cancelled=${m.cancelled_at ?? '-'}`);
      }
    }

    // the deltas that discriminate the hypotheses
    const created = rows.map((r) => new Date(r.created_at).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < created.length; i++) {
      const ms = created[i] - created[i - 1];
      console.log(`   >>> gap between row ${i} and ${i + 1}: ${(ms / 1000).toFixed(1)}s  (${(ms / 3600000).toFixed(2)}h)`);
    }
  }

  // soft-deleted same-text rows give the history
  const dupTexts = dupes.map(([, v]) => v[0].text);
  const { data: gone } = await sb
    .from('items')
    .select('id, text, completed, completed_at, deleted_at, created_at')
    .eq('list_id', list.id)
    .in('text', dupTexts)
    .not('deleted_at', 'is', null)
    .order('created_at', { ascending: true });
  if (gone?.length) {
    console.log(`\n  --- soft-deleted rows with the same text (occurrence history) ---`);
    for (const g of gone) {
      console.log(`   ${g.id.slice(0, 8)}  created=${g.created_at}  completed_at=${g.completed_at ?? '-'}  deleted_at=${g.deleted_at}`);
    }
  }
}
