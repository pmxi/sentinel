import { QueryClient } from "@tanstack/solid-query";
import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { MailboxReplica } from "./replica";
import type { ReplicaDelta, ReplicaRow } from "./replica-types";

vi.mock("./api", async () => ({ ...(await vi.importActual("./api")), api: vi.fn() }));
const interval = vi.hoisted(() => ({ value: 60_000 }));
vi.mock("./live", () => ({ liveInterval: () => interval.value }));
const empty = (cursor: string): ReplicaDelta => ({
  cursor,
  upserts: [],
  deletions: [],
  accounts: [],
});
const row = (id: string) => ({ id, threadId: `thread-${id}`, subject: id }) as ReplicaRow;
class ReplicaWorker {
  static latest: ReplicaWorker;
  onmessage?: (event: { data: { id: number; result: unknown } }) => void;
  onerror?: () => void;
  rows = new Map<string, ReplicaRow>();
  deltas: ReplicaDelta[] = [];
  terminate() {}
  constructor() {
    ReplicaWorker.latest = this;
  }
  postMessage({ id, method, args }: { id: number; method: string; args: unknown[] }) {
    let result: unknown;
    if (method === "init") result = { persistent: false, cursor: "base" };
    else if (method === "delta") {
      const delta = args[0] as ReplicaDelta;
      this.deltas.push(delta);
      for (const row of delta.upserts) this.rows.set(row.id, row);
      for (const id of delta.deletions) this.rows.delete(id);
    } else if (method === "list") result = { messages: [...this.rows.values()], nextCursor: null };
    else if (method === "recent") result = [];
    queueMicrotask(() => this.onmessage?.({ data: { id, result } }));
  }
}
const active: MailboxReplica[] = [];
async function setup(canPoll = () => true) {
  const client = new QueryClient();
  client.setQueryData(["messages", "l1"], { messages: [], nextCursor: null, pageCount: 1 });
  const replica = new MailboxReplica(client, canPoll, () => true);
  active.push(replica);
  await vi.advanceTimersByTimeAsync(2000);
  expect(replica.ready()).toBe(true);
  vi.mocked(api).mockClear();
  return { client, replica, worker: ReplicaWorker.latest };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ReplicaWorker);
  interval.value = 60_000;
  vi.mocked(api).mockImplementation(async () => empty("base") as never);
});
afterEach(async () => {
  for (const replica of active.splice(0)) await replica.close();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("replica live synchronization", () => {
  it("rejects old live frames during and after an unchanged HTTP poll", async () => {
    const { replica, worker } = await setup();
    await replica.receiveLive({
      from: "base",
      revision: replica.syncRevision(),
      delta: { ...empty("held"), upserts: [row("new-mail")] },
    });
    const stale = {
      from: "held",
      revision: replica.syncRevision(),
      delta: { ...empty("old-published"), deletions: ["new-mail"] },
    };
    let resolve!: (value: ReplicaDelta) => void;
    vi.mocked(api).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    replica.wake();
    const received = replica.receiveLive(stale);
    vi.mocked(api).mockResolvedValue(empty("held"));
    resolve(empty("held"));
    await received;
    expect(replica.syncCursor()).toBe("held");
    expect([...worker.rows.keys()]).toEqual(["new-mail"]);
    await replica.receiveLive(stale);
    expect(replica.syncCursor()).toBe("held");
    expect([...worker.rows.keys()]).toEqual(["new-mail"]);
    expect(worker.deltas.some((delta) => delta.cursor === "old-published")).toBe(false);
  });
  it("re-announces the current cursor reactively after every HTTP sync", async () => {
    const { replica, worker } = await setup();
    const cursors: (string | undefined)[] = [];
    let stop!: () => void;
    createRoot((dispose) => {
      stop = dispose;
      createEffect(() => {
        cursors.push(replica.syncCursor());
      });
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cursors).toEqual(["base"]);
      vi.mocked(api).mockResolvedValue({ ...empty("http-new"), upserts: [row("new-mail")] });
      replica.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(cursors).toEqual(["base", "http-new"]);
      vi.mocked(api).mockResolvedValue(empty("http-verified"));
      replica.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(cursors).toEqual(["base", "http-new", "http-verified"]);
      await replica.receiveLive({
        from: "http-new",
        delta: { ...empty("stale-socket"), deletions: ["new-mail"] },
      });
      expect(replica.syncCursor()).toBe("http-verified");
      expect([...worker.rows.keys()]).toEqual(["new-mail"]);
    } finally {
      stop();
    }
  });
  it("applies matching deltas and refreshes caches without a delta request, with no duplicate rows", async () => {
    const { client, replica, worker } = await setup();
    const delta = { ...empty("pushed"), upserts: [row("new")] };
    await replica.receiveLive({ from: "base", delta, revision: replica.syncRevision() });
    expect(api).not.toHaveBeenCalled();
    expect(replica.syncCursor()).toBe("pushed");
    expect(
      client
        .getQueryData<{ messages: { id: string }[] }>(["messages", "l1"])
        ?.messages.map((row) => row.id),
    ).toEqual(["new"]);
    vi.mocked(api).mockResolvedValue(empty("pushed"));
    await replica.receiveLive({ from: "base", delta, revision: replica.syncRevision() });
    expect(api).toHaveBeenCalledOnce();
    expect([...worker.rows.keys()]).toEqual(["new"]);
    expect(worker.deltas.filter((delta) => delta.upserts.length)).toHaveLength(1);
  });
  it("serializes an in-flight HTTP read with pushes and catches up instead of applying an out-of-order frame", async () => {
    const { replica, worker } = await setup();
    let resolve!: (value: ReplicaDelta) => void;
    vi.mocked(api).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    replica.wake();
    const received = replica.receiveLive({
      from: "base",
      revision: replica.syncRevision(),
      delta: { ...empty("pushed"), upserts: [row("new")] },
    });
    vi.mocked(api).mockResolvedValue({ ...empty("latest"), upserts: [row("new")] });
    resolve(empty("http"));
    await received;
    expect(replica.syncCursor()).toBe("latest");
    expect(worker.deltas.map((delta) => delta.cursor)).toEqual(["base", "http", "latest"]);
    expect([...worker.rows.keys()]).toEqual(["new"]);
  });
  it("retains a push during optimistic mutations and applies it when the quiet period ends", async () => {
    let allowed = true;
    const { replica, worker } = await setup(() => allowed);
    allowed = false;
    const received = replica.receiveLive({
      from: "base",
      revision: replica.syncRevision(),
      delta: { ...empty("next"), upserts: [row("new")] },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.rows.size).toBe(0);
    allowed = true;
    await vi.advanceTimersByTimeAsync(250);
    await received;
    expect(worker.rows.size).toBe(1);
    expect(api).not.toHaveBeenCalled();
  });
  it("uses sixty-second safety polling and restores four-second polling on a failed socket", async () => {
    const { replica } = await setup();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledOnce();
    interval.value = 4000;
    replica.wake();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(api).mockClear();
    await vi.advanceTimersByTimeAsync(3999);
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledOnce();
  });
});
