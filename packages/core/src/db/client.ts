import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config.ts";
import * as schema from "./schema.ts";

let pool: Pool | undefined;

export function getPool(): Pool {
  pool ??= new Pool({
    connectionString: env().DATABASE_URL,
    max: env().NODE_ENV === "test" ? 2 : 12,
    application_name: "sent",
  });
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function databaseIsReady(): Promise<boolean> {
  try {
    await getPool().query("select 1");
    return true;
  } catch {
    return false;
  }
}
