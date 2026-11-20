import type { QueryClient, QueryKey } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import { ApiError, api, type CacheResponse, sentApi } from "./api";
import { type LiveDelta, liveInterval } from "./live";
import {
  REPLICA_CHANNEL,
  REPLICA_RESET_EVENT,
  REPLICA_REVOKED_KEY,
  replicaStorageReady,
} from "./replica-session";
import {
  REPLICA_SESSION_KEY,
  type ReplicaChange,
  type ReplicaDelta,
  type ReplicaDetail,
  type ReplicaList,
  type ReplicaPage,
  type ReplicaRow,
} from "./replica-types";
import type { Account, MessageDetail, SearchResponse } from "./shared";
import { UNAUTHORIZED_EVENT } from "./shell-metadata";

const replicas = new WeakMap<QueryClient, MailboxReplica>();
type RpcReply = { id: number; result?: unknown; error?: string };
type LocalMessage = MessageDetail & { localBodyPending?: boolean };
export const localBodyPending = (message?: MessageDetail) =>
  Boolean((message as LocalMessage | undefined)?.localBodyPending);
export const replicaReady = (client: QueryClient) => replicas.get(client)?.ready() ?? false;
export const replicaFor = (client: QueryClient) => replicas.get(client);
export function replicaId() {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createMailboxReplica(...args: ConstructorParameters<typeof MailboxReplica>) {
  try {
    return new MailboxReplica(...args);
  } catch {
    replicas.delete(args[0]);
    return undefined;
  }
}
function sessionId() {
  try {
    const old = localStorage.getItem(REPLICA_SESSION_KEY);
    if (old && localStorage.getItem(REPLICA_REVOKED_KEY) === old)
      return { id: replicaId(), persistent: false };
    if (old && /^[a-f0-9-]{36}$/.test(old)) return { id: old, persistent: true };
  } catch {}
  const id = replicaId();
  try {
    localStorage.setItem(REPLICA_SESSION_KEY, id);
    return { id, persistent: localStorage.getItem(REPLICA_SESSION_KEY) === id };
  } catch {}
  return { id, persistent: false };
}
async function removeDirectory(id: string) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`.sent-mailbox-${id}`, { recursive: true });
  } catch {}
}
export class MailboxReplica {
  private identity = sessionId();
  get id() {
    return this.identity.id;
  }
  readonly ready: () => boolean;
  private setReady: (value: boolean) => void;
  private worker?: Worker;
  private closed = false;
  private next = 0;
  private calls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private startup?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private cursor?: string;
  private revision = 0;
  private bodies = new Map<string, Promise<void>>();
  private channel?: BroadcastChannel;
  private persistent = false;
  private hydrated = createSignal(false);
  private bodiesHydrated = createSignal(false);
  private syncingBodies = false;
  private closing?: Promise<void>;
  private initialized = false;
  private polling?: Promise<void>;
  private pollAgain = false;
  private liveDirty = false;
  private pendingPush?: LiveDelta;
  constructor(
    private client: QueryClient,
    private canPoll: () => boolean,
    private verified: () => boolean,
  ) {
    [this.ready, this.setReady] = createSignal(false);
    replicas.set(client, this);
    window.addEventListener(REPLICA_RESET_EVENT, this.reset);
    try {
      this.channel = new BroadcastChannel(REPLICA_CHANNEL);
      this.channel.onmessage = (event) => {
        if (event.data?.id === this.id) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      };
    } catch {}
    this.startup = setTimeout(() => void this.start(), 2000);
  }
  private reset = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: string; pending?: Promise<unknown>[] }>).detail;
    if (!detail?.id || detail.id === this.id) {
      const wipe = this.close(true);
      detail?.pending?.push(wipe);
    }
  };
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const worker = this.worker;
    if (!worker || this.closed) return Promise.reject(new Error("Replica is unavailable"));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("Replica operation timed out"));
      }, 30_000);
      this.calls.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      worker.postMessage({ id, method, args });
    });
  }
  private async start() {
    if (this.closed || typeof Worker === "undefined") return;
    try {
      await replicaStorageReady();
      try {
        if (
          localStorage.getItem(REPLICA_SESSION_KEY) !== this.id &&
          !localStorage.getItem(REPLICA_REVOKED_KEY)
        )
          this.identity = sessionId();
      } catch {}
      this.worker = new Worker(new URL("./replica-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<RpcReply>) => {
        const call = this.calls.get(event.data.id);
        if (!call) return;
        this.calls.delete(event.data.id);
        clearTimeout(call.timer);
        if (event.data.error) call.reject(new Error(event.data.error));
        else call.resolve(event.data.result);
      };
      this.worker.onerror = () => this.fail();
      const state = await this.call<{ persistent: boolean; cursor?: string }>(
        "init",
        this.id,
        this.identity.persistent,
      );
      if (this.closed) return;
      this.persistent = state.persistent;
      this.cursor = state.cursor;
      this.initialized = true;
      if (this.cursor) {
        this.setReady(true);
        await this.refresh();
        this.hydrated[1](true);
      }
      await this.poll();
    } catch {
      this.fail();
    }
  }
  private fail() {
    if (this.closed) return;
    const wasReady = this.ready();
    void this.close(false);
    if (wasReady)
      for (const family of ["messages", "message", "thread"])
        void this.client.resetQueries({ queryKey: [family] });
  }
  private async fetchDelta(cursor: string) {
    return api<ReplicaDelta>(`/api/sync/delta?cursor=${encodeURIComponent(cursor)}`, {
      signal: this.controller.signal,
      cache: "no-store",
    });
  }
  private async bootstrap() {
    await this.call("reset");
    let next: string | null = null,
      baseline = "",
      accounts: Account[] = [];
    do {
      const page: ReplicaPage = await api(
        `/api/sync/snapshot?limit=2000${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        { signal: this.controller.signal, cache: "no-store" },
      );
      await this.call("stage", page.messages);
      next = page.nextCursor;
      baseline = page.cursor;
      accounts = page.accounts;
    } while (next && !this.closed);
    while (!this.closed) {
      if (!this.canPoll() || !this.verified()) {
        await new Promise((done) => setTimeout(done, 250));
        continue;
      }
      const revision = this.revision,
        delta = await this.fetchDelta(baseline);
      if (revision !== this.revision || !this.canPoll()) continue;
      await this.call("delta", delta, true);
      baseline = delta.cursor;
      accounts = delta.accounts;
      if (revision !== this.revision || !this.canPoll()) continue;
      const committed = this.call("commit", baseline);
      this.cursor = baseline;
      await committed;
      this.setReady(true);
      this.client.setQueryData(["accounts"], { accounts });
      await this.refresh();
      this.hydrated[1](true);
      return;
    }
    if (this.closed) return;
  }
  syncCursor() {
    return this.cursor;
  }
  wake() {
    if (this.initialized && !this.closed) void this.poll();
  }
  receiveLive(frame?: LiveDelta) {
    this.liveDirty = true;
    this.pendingPush = frame;
    return this.initialized ? this.poll() : Promise.resolve();
  }
  private poll(): Promise<void> {
    if (this.closed || this.controller.signal.aborted) return Promise.resolve();
    clearTimeout(this.timer);
    this.pollAgain = true;
    if (this.polling) return this.polling;
    this.polling = (async () => {
      while (this.pollAgain && !this.closed) {
        while (
          this.liveDirty &&
          !this.canPoll() &&
          navigator.onLine !== false &&
          this.verified() &&
          !this.controller.signal.aborted
        )
          await new Promise((done) => setTimeout(done, 250));
        this.pollAgain = false;
        await this.pollOnce();
      }
    })().finally(() => {
      this.polling = undefined;
      if (!this.closed && !this.controller.signal.aborted) {
        void this.syncRecentBodies();
        const delay =
          this.liveDirty && navigator.onLine !== false && this.verified()
            ? 250
            : liveInterval(this.client);
        this.timer = setTimeout(() => void this.poll(), delay);
      }
    });
    return this.polling;
  }
  private async pollOnce() {
    if (this.closed || this.controller.signal.aborted) return;
    try {
      if (navigator.onLine !== false && this.verified() && this.canPoll()) {
        const push = this.pendingPush;
        this.pendingPush = undefined;
        this.liveDirty = false;
        if (!this.cursor) await this.bootstrap();
        else {
          const revision = this.revision,
            delta = push?.from === this.cursor ? push.delta : await this.fetchDelta(this.cursor);
          if (revision === this.revision && this.canPoll() && !this.controller.signal.aborted) {
            await this.call("delta", delta, false);
            this.cursor = delta.cursor;
            this.client.setQueryData(["accounts"], { accounts: delta.accounts });
            if (delta.upserts.length || delta.deletions.length) await this.refresh();
          } else this.liveDirty = true;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        this.cursor = undefined;
        this.liveDirty = true;
      } else if (
        !(error instanceof ApiError) &&
        !(error instanceof TypeError) &&
        !this.controller.signal.aborted
      )
        this.fail();
    }
  }
  async list(params: URLSearchParams) {
    return this.call<ReplicaList>("list", {
      view: params.get("view") ?? "l1",
      accountId: params.get("accountId") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
      limit: Number(params.get("limit") ?? 75),
    });
  }
  async search(text: string, limit = 75) {
    return this.call<SearchResponse>("search", text, limit);
  }
  private async syncRecentBodies() {
    if (
      this.syncingBodies ||
      this.closed ||
      !this.ready() ||
      navigator.onLine === false ||
      !this.verified() ||
      !this.canPoll()
    )
      return;
    this.syncingBodies = true;
    try {
      while (!this.closed && this.canPoll()) {
        const ids = await this.call<string[]>("recent");
        if (!ids.length) {
          this.bodiesHydrated[1](true);
          return;
        }
        this.bodiesHydrated[1](false);
        await this.ensureBodies(ids, this.controller.signal, false);
      }
    } catch (error) {
      if (!(error instanceof ApiError) && !(error instanceof TypeError) && !this.closed)
        this.fail();
    } finally {
      this.syncingBodies = false;
    }
  }
  opened(ids: string[]) {
    if (ids.length && this.ready()) void this.call("opened", ids).catch(() => this.fail());
  }
  private seed(key: QueryKey, rows: ReplicaDetail[], thread = false) {
    if (this.closed || this.controller.signal.aborted) return;
    const messages = rows.map((row) => ({
      ...row.message,
      ...(!row.hasBody ? { localBodyPending: true } : {}),
    }));
    this.client.setQueryData(key, thread ? { messages } : (messages[0] ?? null));
  }
  private async ensureBodies(ids: string[], signal?: AbortSignal, opened = true) {
    const pending: Promise<void>[] = [],
      fresh = ids.filter((id) => !this.bodies.has(id));
    for (let index = 0; index < fresh.length; index += 16) {
      const batch = fresh.slice(index, index + 16);
      const request = (async () => {
        const result = await api<{ messages: ReplicaRow[] }>(
          `/api/sync/bodies?ids=${batch.join(",")}`,
          { signal, cache: "no-store", priority: opened ? "high" : "low" },
        );
        await this.call("bodies", result.messages, opened, batch);
        void this.client.invalidateQueries({ queryKey: ["search"], refetchType: "active" });
      })();
      const tracked = request.finally(() => {
        for (const id of batch) this.bodies.delete(id);
      });
      for (const id of batch) this.bodies.set(id, tracked);
      pending.push(tracked);
    }
    for (const id of ids)
      if (!fresh.includes(id)) {
        const existing = this.bodies.get(id);
        if (existing) pending.push(existing);
      }
    await Promise.all(pending);
  }
  async message(id: string, signal?: AbortSignal, prefetch = false): Promise<MessageDetail> {
    let row = await this.call<ReplicaDetail | undefined>("detail", id, !prefetch);
    if (row?.hasBody) return row.message;
    if (row) this.seed(["message", id], [row]);
    await this.ensureBodies([id], signal, !prefetch);
    row = await this.call("detail", id, !prefetch);
    if (row?.hasBody) return row.message;
    return sentApi.message(id, signal);
  }
  async thread(
    id: string,
    trash: boolean,
    signal?: AbortSignal,
  ): Promise<{ messages: MessageDetail[] }> {
    let rows = await this.call<ReplicaDetail[]>("thread", id, trash, true);
    if (!rows.length) return sentApi.thread(id, trash, signal);
    const missing = rows.filter((row) => !row.hasBody).map((row) => row.message.id);
    if (missing.length) {
      this.seed(["thread", id, trash], rows, true);
      await this.ensureBodies(missing, signal);
      rows = await this.call("thread", id, trash, true);
    }
    if (rows.some((row) => !row.hasBody)) return sentApi.thread(id, trash, signal);
    return { messages: rows.map((row) => row.message) };
  }
  begin(change: ReplicaChange) {
    this.revision++;
    const token = replicaId(),
      active = this.ready();
    if (active) void this.call("begin", token, change).catch(() => this.fail());
    return {
      commit: (response?: CacheResponse) => {
        if (active) void this.call("settle", token, true, response).catch(() => this.fail());
      },
      rollback: (response?: CacheResponse) => {
        if (active) void this.call("settle", token, false, response).catch(() => this.fail());
      },
    };
  }
  private async refresh() {
    if (this.closed || this.controller.signal.aborted) return;
    void this.client.invalidateQueries({ queryKey: ["search"], refetchType: "active" });
    const revision = this.revision;
    for (const query of this.client.getQueryCache().getAll()) {
      if (this.closed || this.controller.signal.aborted || revision !== this.revision) return;
      const key = query.queryKey,
        family = key[0];
      if (
        ["messages", "message", "thread"].includes(String(family)) &&
        query.state.fetchStatus === "fetching"
      )
        void this.client.cancelQueries({ queryKey: key, exact: true });
      const updates = query.state.dataUpdateCount;
      if (family === "messages") {
        const count = (query.state.data as { pageCount?: number } | undefined)?.pageCount ?? 1;
        let cursor: string | null = null;
        const messages: ReplicaList["messages"] = [];
        for (let page = 0; page < count; page++) {
          const result: ReplicaList = await this.call<ReplicaList>("list", {
            view: String(key[1]),
            accountId: key[2],
            cursor: cursor ?? undefined,
            limit: 75,
          });
          messages.push(...result.messages);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (
          !this.controller.signal.aborted &&
          revision === this.revision &&
          query.state.dataUpdateCount === updates
        )
          this.client.setQueryData(key, { messages, nextCursor: cursor, pageCount: count });
      } else if (family === "message" || family === "thread") {
        const rows =
          family === "message"
            ? [await this.call<ReplicaDetail | undefined>("detail", String(key[1]))].filter(
                (value): value is ReplicaDetail => Boolean(value),
              )
            : await this.call<ReplicaDetail[]>("thread", String(key[1]), Boolean(key[2]));
        if (
          this.controller.signal.aborted ||
          revision !== this.revision ||
          query.state.dataUpdateCount !== updates
        )
          continue;
        this.seed(key, rows, family === "thread");
        if (rows.some((row) => !row.hasBody))
          void this.client.invalidateQueries({ queryKey: key, exact: true });
      }
    }
  }
  status() {
    return {
      ready: this.ready() && this.hydrated[0](),
      bodiesReady: this.bodiesHydrated[0](),
      persistent: this.persistent,
      session: this.id,
    };
  }
  disable() {
    this.fail();
  }
  close(wipe = false) {
    this.closing ??= this.shutdown(wipe);
    return this.closing;
  }
  private async shutdown(wipe: boolean) {
    if (this.closed) return;
    this.setReady(false);
    clearTimeout(this.startup);
    clearTimeout(this.timer);
    this.controller.abort();
    window.removeEventListener(REPLICA_RESET_EVENT, this.reset);
    this.channel?.close();
    if (wipe && this.worker)
      try {
        await this.call("wipe");
      } catch {}
    this.closed = true;
    this.worker?.terminate();
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Replica closed"));
    }
    this.calls.clear();
    if (replicas.get(this.client) === this) replicas.delete(this.client);
    if (wipe) await removeDirectory(this.id);
  }
}
export async function mailboxRead(
  client: QueryClient,
  params: URLSearchParams,
  signal?: AbortSignal,
) {
  const replica = replicas.get(client);
  if (replica?.ready())
    try {
      return await replica.list(params);
    } catch (error) {
      if (signal?.aborted) throw error;
      replica.disable();
      if (params.get("cursor")?.startsWith("local:")) throw error;
    }
  return sentApi.messages(params, signal);
}
export async function messageRead(
  client: QueryClient,
  id: string,
  signal?: AbortSignal,
  prefetch = false,
) {
  const replica = replicas.get(client);
  if (replica?.ready())
    try {
      return await replica.message(id, signal, prefetch);
    } catch (error) {
      if (
        signal?.aborted ||
        client.getQueryData<{ authenticated: boolean }>(["session"])?.authenticated === false
      )
        throw error;
      if (!(error instanceof ApiError) && !(error instanceof TypeError)) replica.disable();
    }
  return sentApi.message(id, signal);
}
export async function threadRead(
  client: QueryClient,
  id: string,
  trash: boolean,
  signal?: AbortSignal,
) {
  const replica = replicas.get(client);
  if (replica?.ready())
    try {
      return await replica.thread(id, trash, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        client.getQueryData<{ authenticated: boolean }>(["session"])?.authenticated === false
      )
        throw error;
      if (!(error instanceof ApiError) && !(error instanceof TypeError)) replica.disable();
    }
  return sentApi.thread(id, trash, signal);
}
