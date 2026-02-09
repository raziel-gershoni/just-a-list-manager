import postgres from "postgres";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log("[Migrate] DATABASE_URL not set — skipping migrations");
  process.exit(0);
}

const sql = postgres(DATABASE_URL, { ssl: "require" });

async function run() {
  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  // Get already-applied migrations
  const applied = await sql`SELECT name FROM _migrations ORDER BY name`;
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files
  const migrationsDir = join(process.cwd(), "supabase", "migrations");
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[Migrate] Already applied: ${file}`);
      continue;
    }

    console.log(`[Migrate] Applying: ${file}`);
    const content = await readFile(join(migrationsDir, file), "utf-8");

    try {
      await sql.unsafe(content);
      await sql`INSERT INTO _migrations (name) VALUES (${file})`;
      count++;
      console.log(`[Migrate] Applied: ${file}`);
    } catch (err) {
      console.error(`[Migrate] Failed on ${file}:`, err.message);
      process.exit(1);
    }
  }

  console.log(
    count > 0
      ? `[Migrate] Done — ${count} migration(s) applied`
      : "[Migrate] Up to date"
  );
  await sql.end();
}

run().catch((err) => {
  console.error("[Migrate] Fatal:", err);
  process.exit(1);
});
