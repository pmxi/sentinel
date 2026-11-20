import sqlite3InitModule, { type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import type { CacheResponse } from "./api";
import { packBody, unpackDetail } from "./replica-body";
import { ReplicaStore } from "./replica-store";
import type { ReplicaChange, ReplicaDelta, ReplicaRow } from "./replica-types";

let store: ReplicaStore | undefined;
let pool: SAHPoolUtil | undefined;
let sequence = Promise.resolve();
const sqliteReady = sqlite3InitModule();
async function compareSearchStorage(terms: string[]) {
  if (!store) throw new Error("Replica is closed");
  const source = store;
  const sqlite = await sqliteReady;
  const pointer = source.db.pointer;
  if (!pointer) throw new Error("Replica is closed");
  const bytes = sqlite.capi.sqlite3_js_db_export(pointer);
  const memory = new sqlite.oo1.DB(":memory:", "c");
  const buffer = sqlite.wasm.allocFromTypedArray(bytes);
  const rc = sqlite.capi.sqlite3_deserialize(
    memory.pointer as typeof pointer,
    "main",
    buffer,
    bytes.byteLength,
    bytes.byteLength,
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc) {
    memory.close();
    throw new Error(`Deserialize failed: ${rc}`);
  }
  try {
    const replica = new ReplicaStore(memory);
    const samples = [];
    for (const term of terms)
      for (const cache of ["cold", "warm"])
        for (let iteration = 0; iteration < 6; iteration++) {
          const results = [];
          for (const arm of iteration % 2 ? ["memory", "opfs"] : ["opfs", "memory"]) {
            const target = arm === "memory" ? replica : source;
            if (cache === "cold") target.db.exec("pragma shrink_memory");
            const { result, profile } = target.profileSearch(term, 20);
            results.push(JSON.stringify(result));
            samples.push({ term, cache, iteration, arm, profile });
          }
          if (results[0] !== results[1])
            throw new Error("Storage comparison changed search results");
        }
    return { databaseBytes: bytes.byteLength, samples };
  } finally {
    memory.close();
  }
}
async function dispatch(method: string, args: unknown[]) {
  if (method === "init") {
    const session = String(args[0]);
    if (!/^[a-f0-9-]{36}$/.test(session)) throw new Error("Invalid replica session");
    const sqlite = await sqliteReady;
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
    case "search":
      return store.search(String(args[0]), Number(args[1] ?? 75));
    case "detail":
      return unpackDetail(store.detail(String(args[0]), Boolean(args[1])));
    case "thread":
      return Promise.all(
        store.thread(String(args[0]), Boolean(args[1]), Boolean(args[2])).map(unpackDetail),
      );
    case "bodies": {
      const rows = args[0] as ReplicaRow[],
        packed = new Map<string, Uint8Array>();
      await Promise.all(
        rows
          .filter((row) => row.bodyAvailable)
          .map(async (row) => {
            const bytes = await packBody(row);
            if (bytes) packed.set(row.id, bytes);
          }),
      );
      return store.bodies(rows, args[1] !== false, args[2] as string[] | undefined, packed);
    }
    case "recent":
      return store.recentBodies();
    case "stats":
      return store.storageStats();
    case "diagnostics":
      return store.storageDetails();
    case "plans":
      return store.queryPlans(args[0] as Parameters<ReplicaStore["list"]>[0]);
    case "searchPlans":
      return store.searchPlans(String(args[0]), Number(args[1] ?? 75));
    case "compareSearchStorage":
      return compareSearchStorage(args[0] as string[]);
    case "opened":
      return store.opened(args[0] as string[]);
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
self.onmessage = (
  event: MessageEvent<{ id: number; method: string; args: unknown[]; profile?: boolean }>,
) => {
  const { id, method, args } = event.data;
  const receivedAt = performance.timeOrigin + performance.now();
  sequence = sequence.then(async () => {
    try {
      if (event.data.profile && (method === "list" || method === "search") && store) {
        const sqlite = await sqliteReady;
        const pointer = store.db.pointer;
        if (!pointer) throw new Error("Replica is closed");
        const buffer = sqlite.wasm.alloc(8);
        const counter = (
          op:
            | typeof sqlite.capi.SQLITE_DBSTATUS_CACHE_HIT
            | typeof sqlite.capi.SQLITE_DBSTATUS_CACHE_MISS,
        ) => {
          sqlite.capi.sqlite3_db_status(pointer, op, buffer, buffer + 4, 0);
          return sqlite.wasm.peek32(buffer);
        };
        const hits = counter(sqlite.capi.SQLITE_DBSTATUS_CACHE_HIT);
        const misses = counter(sqlite.capi.SQLITE_DBSTATUS_CACHE_MISS);
        const startedAt = performance.timeOrigin + performance.now();
        const { result, profile } =
          method === "search"
            ? store.profileSearch(String(args[0]), Number(args[1] ?? 75))
            : store.profileList(args[0] as Parameters<ReplicaStore["list"]>[0]);
        self.postMessage({
          id,
          result,
          profile: {
            ...profile,
            cache: {
              targetKiB: store.db.selectValue("pragma cache_size"),
              hits: counter(sqlite.capi.SQLITE_DBSTATUS_CACHE_HIT) - hits,
              misses: counter(sqlite.capi.SQLITE_DBSTATUS_CACHE_MISS) - misses,
            },
            receivedAt,
            startedAt,
            endedAt: performance.timeOrigin + performance.now(),
          },
        });
        sqlite.wasm.dealloc(buffer);
        return;
      }
      const result = await dispatch(method, args);
      await store?.restoreSearch();
      self.postMessage({ id, result });
    } catch (cause) {
      self.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
};
