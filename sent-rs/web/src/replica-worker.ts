import sqlite3InitModule, { type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import type { CacheResponse } from "./api";
import { ReplicaStore } from "./replica-store";
import type { ReplicaChange, ReplicaDelta, ReplicaRow } from "./replica-types";

let store: ReplicaStore | undefined;
let pool: SAHPoolUtil | undefined;
let sequence = Promise.resolve();
async function dispatch(method: string, args: unknown[]) {
  if (method === "init") {
    const session = String(args[0]);
    if (!/^[a-f0-9-]{36}$/.test(session)) throw new Error("Invalid replica session");
    const sqlite = await sqlite3InitModule();
    try {
      if (args[1] === false) throw new Error("Persistent session identity unavailable");
      pool = await sqlite.installOpfsSAHPoolVfs({
        name: "sent-mailbox",
        directory: `.sent-mailbox-${session}`,
        initialCapacity: 6,
        preserveOnInitFailure: true,
      });
    } catch {
      pool = undefined;
    }
    store = new ReplicaStore(
      pool ? new pool.OpfsSAHPoolDb("/mail.sqlite3") : new sqlite.oo1.DB(":memory:", "c"),
    );
    return { persistent: Boolean(pool), cursor: store.cursor(), count: store.count() };
  }
  if (!store) throw new Error("Replica is closed");
  switch (method) {
    case "reset":
      return store.resetStage();
    case "stage":
      return store.stage(args[0] as ReplicaRow[]);
    case "commit":
      return store.commitStage(String(args[0]));
    case "delta":
      return store.delta(args[0] as ReplicaDelta, Boolean(args[1]));
    case "list":
      return store.list(args[0] as Parameters<ReplicaStore["list"]>[0]);
    case "detail":
      return store.detail(String(args[0]));
    case "thread":
      return store.thread(String(args[0]), Boolean(args[1]));
    case "bodies":
      return store.bodies(args[0] as ReplicaRow[]);
    case "begin":
      return store.begin(String(args[0]), args[1] as ReplicaChange);
    case "settle":
      return store.settle(String(args[0]), Boolean(args[1]), args[2] as CacheResponse | undefined);
    case "wipe":
      store.db.close();
      store = undefined;
      if (pool) {
        await pool.removeVfs();
        pool = undefined;
      }
      return;
    default:
      throw new Error("Unknown replica operation");
  }
}
self.onmessage = (event: MessageEvent<{ id: number; method: string; args: unknown[] }>) => {
  const { id, method, args } = event.data;
  sequence = sequence.then(async () => {
    try {
      self.postMessage({ id, result: await dispatch(method, args) });
    } catch (cause) {
      self.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
};
