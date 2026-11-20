import type { ConversationSummary, MessageListResponse } from "@sent/shared";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import { refreshPages, useMailbox } from "./mailbox";
import * as replica from "./replica";

const row = (id: string) => ({ id, threadId: id }) as ConversationSummary;
const page = (ids: string[], nextCursor: string | null = null): MessageListResponse => ({
  messages: ids.map(row),
  nextCursor,
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  onlineManager.setOnline(true);
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks();
});
function mailbox() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const [view, setView] = createSignal("l1");
  let result!: ReturnType<typeof useMailbox>;
  function Harness() {
    result = useMailbox(view, () => "account");
    return null;
  }
  const container = document.createElement("div");
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          return createComponent(Harness, {});
        },
      }),
    container,
  );
  cleanup.push(() => {
    dispose();
    client.clear();
  });
  return {
    get result() {
      return result;
    },
    client,
    setView,
  };
}
describe("mailbox pagination", () => {
  it("executes local reads while the connectivity manager is offline", async () => {
    onlineManager.setOnline(false);
    const read = vi.spyOn(replica, "mailboxRead").mockResolvedValue(page(["cached"]));
    const scope = mailbox();
    await vi.waitFor(() => expect(scope.result.query.data?.messages[0]?.id).toBe("cached"));
    expect(read).toHaveBeenCalled();
  });
  it("refreshes all loaded pages with fresh cursors and deduplicates boundary rows", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(page(["a", "b"], "fresh"))
      .mockResolvedValueOnce(page(["b", "c"]));
    await expect(refreshPages(load, 3)).resolves.toEqual({
      ...page(["a", "b", "c"]),
      pageCount: 2,
    });
    expect(load.mock.calls).toEqual([[undefined], ["fresh"]]);
  });
  it("handles an empty mailbox and propagates request/loop errors", async () => {
    await expect(refreshPages(async () => page([]), 1)).resolves.toEqual({
      ...page([]),
      pageCount: 1,
    });
    await expect(
      refreshPages(async () => {
        throw new Error("Offline");
      }, 1),
    ).rejects.toThrow("Offline");
    await expect(refreshPages(async () => page(["a"], "same"), 2)).rejects.toThrow(
      "did not advance",
    );
  });
  it("starts at75, appends one page, and refetches without truncating loaded rows", async () => {
    const request = vi
      .spyOn(sentApi, "messages")
      .mockResolvedValueOnce(page(["a", "b"], "next"))
      .mockResolvedValueOnce(page(["b", "c"]));
    const scope = mailbox();
    await vi.waitFor(() => expect(scope.result.query.data?.messages).toHaveLength(2));
    await scope.result.loadMore();
    await vi.waitFor(() => expect(scope.result.query.data?.messages).toHaveLength(3));
    expect(request.mock.calls.map(([query]) => Object.fromEntries(query))).toEqual([
      { view: "l1", limit: "75", accountId: "account" },
      { view: "l1", limit: "75", accountId: "account", cursor: "next" },
    ]);
    request
      .mockResolvedValueOnce(page(["new", "a"], "updated"))
      .mockResolvedValueOnce(page(["b", "c"]));
    await scope.result.query.refetch();
    expect(scope.result.query.data?.messages.map((item) => item.id)).toEqual([
      "new",
      "a",
      "b",
      "c",
    ]);
    expect(request.mock.calls.at(-1)?.[0].get("cursor")).toBe("updated");
  });
  it("deduplicates concurrent loads and preserves rows on failure for retry", async () => {
    const request = vi.spyOn(sentApi, "messages").mockResolvedValueOnce(page(["a"], "next"));
    const scope = mailbox();
    await vi.waitFor(() => expect(scope.result.query.data?.nextCursor).toBe("next"));
    let reject!: (reason: Error) => void;
    request.mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    const first = scope.result.loadMore();
    expect(scope.result.loadMore()).toBe(first);
    await vi.waitFor(() => expect(reject).toBeDefined());
    reject(new Error("Offline"));
    await first;
    expect(scope.result.error()).toBe("Offline");
    expect(scope.result.query.data?.messages).toHaveLength(1);
    request.mockResolvedValueOnce(page(["b"]));
    await scope.result.loadMore();
    expect(scope.result.error()).toBeUndefined();
    expect(scope.result.query.data?.messages).toHaveLength(2);
  });
  it("aborts an old scope's pending page when the view changes", async () => {
    const request = vi.spyOn(sentApi, "messages").mockResolvedValueOnce(page(["a"], "next"));
    const scope = mailbox();
    await vi.waitFor(() => expect(scope.result.query.data?.nextCursor).toBe("next"));
    let resolve!: (page: MessageListResponse) => void;
    request.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const loading = scope.result.loadMore();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const signal = request.mock.calls.at(-1)?.[1];
    request.mockResolvedValueOnce(page(["other"]));
    scope.setView("l2");
    await vi.waitFor(() => expect(scope.result.query.data?.messages[0].id).toBe("other"));
    expect(signal?.aborted).toBe(true);
    resolve(page(["stale"]));
    await loading;
    expect(scope.result.query.data?.messages.map((item) => item.id)).toEqual(["other"]);
  });
});
