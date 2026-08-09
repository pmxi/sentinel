import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getPool } from "./client.ts";

const migrationDirectory =
  process.env.MIGRATIONS_PATH ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(89372411)");
    await client.query(
      "create table if not exists sent_migrations (filename text primary key, applied_at timestamptz not null default now())",
    );
    const files = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = new Set(
      (await client.query<{ filename: string }>("select filename from sent_migrations")).rows.map(
        (row) => row.filename,
      ),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(await readFile(join(migrationDirectory, file), "utf8"));
        await client.query("insert into sent_migrations(filename) values ($1)", [file]);
        await client.query("commit");
        process.stdout.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(89372411)");
    client.release();
    await closeDb();
  }
}

await migrate();
