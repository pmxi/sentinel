import { readdir, readFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool, type PoolClient } from "pg";
import { validateDatabaseUrl } from "./data.ts";

config({ quiet: true });

let pool: Pool | undefined;
export function getPool() {
  if (!pool) {
    const url = new URL(validateDatabaseUrl(process.env.DATABASE_URL));
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Benchmark database must be local");
    pool = new Pool({ connectionString: url.href, max: 12, allowExitOnIdle: true });
  }
  return pool;
}

export async function closeDb() {
  const current = pool;
  pool = undefined;
  await current?.end();
}

export async function migrate(
  client: Pick<PoolClient, "query">,
  files?: readonly (readonly [string, string])[],
) {
  const directory = new URL("../../migrations/", import.meta.url);
  const migrations =
    files ??
    (await Promise.all(
      (
        await readdir(directory)
      )
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map(async (name) => [name, await readFile(new URL(name, directory), "utf8")] as const),
    ));
  try {
    await client.query("select pg_advisory_lock(89372411)");
    await client.query(
      "create table if not exists sent_migrations (filename text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query("select filename from sent_migrations")).rows.map((row) => row.filename),
    );
    for (const [name, sql] of migrations) {
      if (applied.has(name)) continue;
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into sent_migrations(filename) values ($1)", [name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(89372411)");
  }
}
