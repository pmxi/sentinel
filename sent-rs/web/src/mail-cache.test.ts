import type { ConversationSummary } from "@sent/shared";
import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import { optimistic } from "./mail-cache";
import { headerData, prefetchQueue } from "./prefetch";

const row = {
  id: "one",
  threadId: "thread",
  read: false,
  flagged: false,
  tier: 1,
  modelTier: 2,
  direction: "inbound",
  unreadCount: 2,
  messageCount: 2,
  account: { id: "account" },
  receivedAt: "2026-11-20T00:00:00Z",
  from: [{ name: "Sender", address: "sender@example.test" }],
} as ConversationSummary;
const clients: QueryClient[] = [];
function fixture() {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  for (const key of [
    ["messages", "l1"],
    ["search", "common"],
  ])
    client.setQueryData(key, { messages: [{ ...row }] });
  client.setQueryData(["thread", "thread", false], {
    messages: [{ ...row, unreadCount: undefined, messageCount: undefined }],
  });
  client.setQueryData(["message", "one"], {
    ...row,
    unreadCount: undefined,
    messageCount: undefined,
  });
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("optimistic mailbox transactions", () => {
  it.each(["mark_read", "flag"])(
    "writes %s to list/detail/thread/search synchronously and rolls back",
    (action) => {
      const client = fixture();
      const original = client.getQueryData(["messages", "l1"]);
      const transaction = optimistic(client, { id: "one", action });
      for (const query of client.getQueryCache().getAll()) {
        const data = query.state.data as { messages?: ConversationSummary[] } & ConversationSummary;
        const item = data.messages?.[0] ?? data;
        expect(item[action === "flag" ? "flagged" : "read"]).toBe(
          action === "flag" || item.unreadCount === undefined,
        );
      }
      transaction.rollback();
      expect(client.getQueryData(["messages", "l1"])).toEqual(original);
    },
  );
  it("preserves later unrelated field writes during rollback", () => {
    const client = fixture();
    const first = optimistic(client, { id: "one", action: "mark_read" });
    const second = optimistic(client, { id: "one", action: "flag" });
    second.commit();
    first.rollback();
    expect(client.getQueryData(["message", "one"])).toMatchObject({ read: false, flagged: true });
  });
  it("does not let an older response overwrite a newer optimistic field", () => {
    const client = fixture();
    const first = optimistic(client, { id: "one", action: "mark_read" });
    const second = optimistic(client, { id: "one", action: "flag" });
    first.commit({
      patches: [
        {
          ...row,
          read: true,
          flagged: false,
          archived: false,
          deleted: false,
          classified: true,
          reasoning: null,
          syncPending: true,
        },
      ],
    });
    expect(client.getQueryData(["message", "one"])).toMatchObject({ flagged: true, read: true });
    second.commit();
  });
  it("moves tier membership and restores rows exactly", () => {
    const client = fixture();
    client.setQueryData(["messages", "l3"], { messages: [] });
    const original = client.getQueryData(["messages", "l1"]);
    const transaction = optimistic(client, { id: "one", tier: 3 });
    expect(client.getQueryData(["messages", "l1"])).toEqual({ messages: [] });
    expect(client.getQueryData(["message", "one"])).toMatchObject({ tier: 3 });
    expect(
      client.getQueryData<{ messages: ConversationSummary[] }>(["messages", "l3"])?.messages,
    ).toHaveLength(1);
    transaction.rollback();
    expect(client.getQueryData(["messages", "l1"])).toEqual(original);
    expect(client.getQueryData(["messages", "l3"])).toEqual({ messages: [] });
  });
  it.each(["archive", "delete"])(
    "updates conversation caches for %s, supports exact undo and defers reconciliation",
    async (action) => {
      const client = fixture();
      const original = client.getQueryData(["messages", "l1"]);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const transaction = optimistic(client, {
        threadId: "thread",
        action,
        view: "l1",
        accountId: "account",
      });
      expect(client.getQueryData(["messages", "l1"])).toEqual({ messages: [] });
      transaction.commit();
      expect(invalidate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1499);
      expect(invalidate).not.toHaveBeenCalled();
      transaction.rollback();
      expect(client.getQueryData(["messages", "l1"])).toEqual(original);
      await vi.advanceTimersByTimeAsync(1500);
      expect(invalidate).toHaveBeenCalled();
    },
  );
  it("handles empty and wrong-account caches", () => {
    const client = fixture();
    const original = client.getQueryData(["messages", "l1"]);
    optimistic(client, { threadId: "thread", action: "delete", accountId: "other" }).rollback();
    expect(client.getQueryData(["messages", "l1"])).toEqual(original);
    optimistic(new QueryClient(), { id: "missing", action: "flag" }).rollback();
  });
  it("uses archived state to restrict view-scoped delete and writes authoritative response patches", () => {
    const client = fixture();
    const second = {
      ...row,
      id: "archived",
      archived: true,
      unreadCount: undefined,
      messageCount: undefined,
    };
    const first = { ...second, id: "one", archived: false };
    client.setQueryData(["thread", "thread", false], { messages: [first, second] });
    client.setQueryData(["message", "archived"], second);
    const transaction = optimistic(client, { threadId: "thread", view: "l1", action: "delete" });
    expect(
      client
        .getQueryData<{ messages: ConversationSummary[] }>(["thread", "thread", false])
        ?.messages.map((item) => item.id),
    ).toEqual(["archived"]);
    const patch = {
      ...first,
      deleted: true,
      read: true,
      flagged: true,
      classified: true,
      syncPending: true,
    } as import("./api").MessagePatch;
    transaction.commit({ patches: [patch] });
    expect(client.getQueryData(["message", "one"])).toMatchObject({ flagged: true, deleted: true });
    transaction.rollback({ patches: [{ ...patch, deleted: false }] });
    expect(
      client.getQueryData<{ messages: ConversationSummary[] }>(["thread", "thread", false])
        ?.messages,
    ).toHaveLength(2);
    expect(client.getQueryData(["message", "one"])).toMatchObject({
      deleted: false,
      flagged: true,
    });
  });
});
describe("bounded prefetch", () => {
  it("seeds header fields without fabricating a body", () => {
    expect(headerData(row)).toMatchObject({ id: "one", threadId: "thread", textBody: "" });
    expect(headerData()).toBeUndefined();
  });
  it("deduplicates, caps background concurrency at one and seeds details from threads", async () => {
    const client = fixture();
    client.clear();
    let resolve!: (value: Awaited<ReturnType<typeof sentApi.thread>>) => void;
    const thread = vi.spyOn(sentApi, "thread").mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }) as ReturnType<typeof sentApi.thread>,
    );
    const body = headerData(row) as NonNullable<ReturnType<typeof headerData>>;
    const detail = vi.spyOn(sentApi, "message").mockResolvedValue(body);
    const queue = prefetchQueue(client, false);
    queue.add([row, row, { ...row, id: "two", threadId: "other" }]);
    await vi.advanceTimersByTimeAsync(120);
    expect(thread).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
    resolve({ messages: [body] });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryData(["message", "one"])).toMatchObject({ id: "one" });
    expect(detail).not.toHaveBeenCalled();
    queue.stop();
  });
  it("swallows failed prefetch and can be disposed before it starts", async () => {
    const client = fixture();
    client.clear();
    const request = vi.spyOn(sentApi, "thread").mockRejectedValue(new Error("offline"));
    const detail = vi.spyOn(sentApi, "message").mockRejectedValue(new Error("offline"));
    const queue = prefetchQueue(client, false);
    queue.add([row]);
    await vi.advanceTimersByTimeAsync(121);
    expect(request).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    queue.stop();
    const stopped = prefetchQueue(client, false);
    stopped.add([row]);
    stopped.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
