import { basename, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function validateSQLitePath(path: string | undefined): string {
  if (!path || !isAbsolute(path) || !/^sent_bench_[a-zA-Z0-9_-]+\.sqlite$/.test(basename(path)))
    throw new Error("Requires an absolute local sent_bench_*.sqlite path");
  return path;
}
let database: DatabaseSync | undefined;
export function sqlite() {
  if (!database) {
    database = new DatabaseSync(validateSQLitePath(process.env.SENT_DATABASE_PATH));
    database.exec("pragma foreign_keys=on; pragma busy_timeout=5000");
  }
  return database;
}
const client = {
  async query(sql: string, values: unknown[] = []) {
    const bindings: (string | number | null)[] = [];
    sql = sql.replace(/\$(\d+)/g, (_, n: string) => {
      const v = values[Number(n) - 1];
      bindings.push(
        v === undefined || v === null
          ? null
          : v instanceof Date
            ? v.toISOString()
            : typeof v === "boolean"
              ? Number(v)
              : typeof v === "object"
                ? JSON.stringify(v)
                : (v as string | number),
      );
      return "?";
    });
    const statement = sqlite().prepare(sql);
    const rows = statement.columns().length ? statement.all(...bindings) : [];
    if (!statement.columns().length) statement.run(...bindings);
    return { rows: rows as Record<string, unknown>[] };
  },
  release() {},
};
export const getPool = () => ({ connect: async () => client });
export async function closeDb() {
  database?.close();
  database = undefined;
}

export async function signalMessages(db: { query: typeof client.query }, ids: string[]) {
  const journal = (
    await db.query("select 1 from sqlite_master where type='table' and name='sent_live_changes'")
  ).rows.length;
  if (journal)
    await db.query(
      "insert into sent_live_changes(kind,message_id) select 'message',value from json_each($1)",
      [JSON.stringify(ids)],
    );
  else await db.query("update sent_live_signal set revision=revision+1 where id=1");
}
