import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import { optimistic } from "./mail-cache";
import { headerData, prefetchQueue } from "./prefetch";
import type { ConversationSummary } from "./shared";

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
  vi.setSystemTime(new Date(row.receivedAt).getTime() + 3600000);
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
  it("keeps later loaded pages during optimistic writes and rollback", () => {
    const client = fixture();
    const messages = Array.from({ length: 150 }, (_, index) => ({
      ...row,
      id: index === 0 ? "one" : `message-${index}`,
      threadId: index === 0 ? "thread" : `thread-${index}`,
      receivedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
    client.setQueryData(["messages", "l1"], { messages, pageCount: 2, nextCursor: "third" });
    const transaction = optimistic(client, { id: "one", action: "flag" });
    expect(client.getQueryData<{ messages: unknown[] }>(["messages", "l1"])?.messages).toHaveLength(
      150,
    );
    transaction.rollback();
    expect(client.getQueryData(["messages", "l1"])).toEqual({
      messages,
      pageCount: 2,
      nextCursor: "third",
    });
  });
  it.each([false, true])(
    "restores overlapping automatic/manual reads when both fail (reverse=%s)",
    (reverse) => {
      const client = fixture();
      const automatic = optimistic(client, { id: "one", action: "mark_read" });
      const manual = optimistic(client, { id: "one", action: "mark_unread" });
      for (const transaction of reverse ? [manual, automatic] : [automatic, manual])
        transaction.rollback();
      expect(client.getQueryData(["message", "one"])).toMatchObject({ read: false });
      expect(
        client.getQueryData<{ messages: ConversationSummary[] }>(["messages", "l1"])?.messages[0],
      ).toMatchObject({ read: false, unreadCount: 2 });
    },
  );
  it("preserves a successful manual read intent when the automatic request fails", () => {
    const client = fixture();
    const automatic = optimistic(client, { id: "one", action: "mark_read" });
    const manual = optimistic(client, { id: "one", action: "mark_unread" });
    manual.commit();
    automatic.rollback();
    expect(
      client.getQueryData<{ messages: ConversationSummary[] }>(["messages", "l1"])?.messages[0]
        .unreadCount,
    ).toBe(2);
  });
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
  it("prioritizes selected neighbors over the delayed initial rows", async () => {
    const client = fixture();
    client.clear();
    const body = headerData(row) as NonNullable<ReturnType<typeof headerData>>;
    const thread = vi.spyOn(sentApi, "thread").mockResolvedValue({ messages: [body] });
    const request = vi
      .spyOn(sentApi, "message")
      .mockResolvedValue(headerData(row) as NonNullable<ReturnType<typeof headerData>>);
    const queue = prefetchQueue(client, false);
    queue.add([{ ...row, id: "old", threadId: "old-thread" }]);
    queue.prioritize([row]);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledWith("one", expect.anything());
    expect(request).toHaveBeenCalledTimes(1);
    expect(thread).not.toHaveBeenCalled();
    queue.stop();
  });
  it("seeds header fields without fabricating a body", () => {
    expect(headerData(row)).toMatchObject({ id: "one", threadId: "thread", textBody: "" });
    expect(headerData()).toBeUndefined();
  });
  it("deduplicates and caps recent-message prefetch concurrency without fetching older thread bodies", async () => {
    const client = fixture();
    client.clear();
    let resolve!: (value: Awaited<ReturnType<typeof sentApi.message>>) => void;
    const thread = vi.spyOn(sentApi, "thread");
    const detail = vi.spyOn(sentApi, "message").mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }) as ReturnType<typeof sentApi.message>,
    );
    const body = headerData(row) as NonNullable<ReturnType<typeof headerData>>;
    const queue = prefetchQueue(client, false);
    queue.add([row, row, { ...row, id: "two", threadId: "other" }]);
    await vi.advanceTimersByTimeAsync(120);
    expect(thread).not.toHaveBeenCalled();
    expect(detail).toHaveBeenCalledTimes(1);
    resolve(body);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryData(["message", "one"])).toMatchObject({ id: "one" });
    expect(detail).toHaveBeenCalledTimes(1);
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
    expect(request).not.toHaveBeenCalled();
    expect(detail).toHaveBeenCalledTimes(1);
    queue.stop();
    const stopped = prefetchQueue(client, false);
    stopped.add([row]);
    stopped.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(request).not.toHaveBeenCalled();
    expect(detail).toHaveBeenCalledTimes(1);
  });
  it("never downloads old bodies speculatively", async () => {
    const client = fixture();
    client.clear();
    const detail = vi.spyOn(sentApi, "message"),
      thread = vi.spyOn(sentApi, "thread"),
      queue = prefetchQueue(client, false);
    const old = { ...row, receivedAt: "2000-01-01T00:00:00Z" };
    queue.add([old]);
    queue.prioritize([old]);
    await vi.advanceTimersByTimeAsync(500);
    expect(detail).not.toHaveBeenCalled();
    expect(thread).not.toHaveBeenCalled();
    queue.stop();
  });
});
