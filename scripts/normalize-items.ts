import postgres from "postgres";
import { normalizeForStorage } from "../src/utils/text-normalize";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const sql = postgres(DATABASE_URL, { ssl: "require" });

async function run() {
  const rows = await sql<{ id: string; text: string }[]>`SELECT id, text FROM items`;

  let changed = 0;
  const samples: { id: string; before: string; after: string }[] = [];

  for (const r of rows) {
    const canonical = normalizeForStorage(r.text);
    if (canonical !== r.text) {
      changed++;
      if (samples.length < 10) {
        samples.push({ id: r.id, before: r.text, after: canonical });
      }
      if (!dryRun) {
        await sql`UPDATE items SET text = ${canonical}, updated_at = now() WHERE id = ${r.id}`;
      }
    }
  }

  console.log(`${dryRun ? "Would update" : "Updated"} ${changed} of ${rows.length} rows`);
  if (samples.length > 0) {
    console.log("\nSample of changes:");
    for (const s of samples) {
      console.log(`  ${s.id.slice(0, 8)}  "${s.before}"  ->  "${s.after}"`);
    }
  }
}

run()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error("[normalize-items] Fatal:", err);
    await sql.end();
    process.exit(1);
  });
