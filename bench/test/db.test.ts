import type { PoolClient } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { closeDb, getPool, migrate } from "../src/db.ts";

afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});

it("keeps the pool lazy, local and reusable", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://localhost/sent");
  expect(() => getPool()).toThrow();
  vi.stubEnv("DATABASE_URL", "postgres://remote.example/sent_bench");
  expect(() => getPool()).toThrow("local");
  vi.stubEnv("DATABASE_URL", "postgres://localhost/sent_bench_unit");
  const first = getPool();
  expect(getPool()).toBe(first);
  await closeDb();
  expect(getPool()).not.toBe(first);
});

function connection(applied: string[] = [], fail?: string) {
  const query = vi.fn(async (sql: string) => {
    if (sql === fail) throw new Error("migration failed");
    return {
      rows:
        sql === "select filename from sent_migrations"
          ? applied.map((filename) => ({ filename }))
          : [],
    };
  });
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> };
}

it("applies only pending native migrations in transactions", async () => {
  const { client, query } = connection(["0001.sql"]);
  await migrate(client, [
    ["0001.sql", "old"],
    ["0002.sql", "next"],
  ]);
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "select pg_advisory_lock(89372411)",
    "create table if not exists sent_migrations (filename text primary key, applied_at timestamptz not null default now())",
    "select filename from sent_migrations",
    "begin",
    "next",
    "insert into sent_migrations(filename) values ($1)",
    "commit",
    "select pg_advisory_unlock(89372411)",
  ]);
});

it("unlocks empty migration sets without starting a transaction", async () => {
  const { client, query } = connection();
  await migrate(client, []);
  expect(query).not.toHaveBeenCalledWith("begin");
  expect(query).toHaveBeenLastCalledWith("select pg_advisory_unlock(89372411)");
});

it("rolls back failed SQL and releases its advisory lock", async () => {
  const { client, query } = connection([], "invalid");
  await expect(migrate(client, [["0001.sql", "invalid"]])).rejects.toThrow("migration failed");
  expect(query).toHaveBeenCalledWith("rollback");
  expect(query).not.toHaveBeenCalledWith("commit");
  expect(query).toHaveBeenLastCalledWith("select pg_advisory_unlock(89372411)");
});
