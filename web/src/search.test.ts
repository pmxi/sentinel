import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import * as replica from "./replica";
import { useMailSearch } from "./search";
import type { ConversationSummary, SearchResponse, SearchSort } from "./shared";

const row = (id: string) => ({ id, threadId: id, subject: id }) as ConversationSummary;
const local: SearchResponse = { mode: "lexical", messages: [row("local")] };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function scope(sort: SearchSort = "relevance") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const [query, setQuery] = createSignal("needle");
  let result!: ReturnType<typeof useMailSearch>;
  function Harness() {
    result = useMailSearch(query, () => sort);
    return null;
  }
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          return createComponent(Harness, {});
        },
      }),
    document.createElement("div"),
  );
  cleanup.push(() => {
    dispose();
    client.clear();
  });
  return {
    get result() {
      return result;
    },
    setQuery,
    dispose,
    client,
  };
}
function ready(search = vi.fn().mockResolvedValue(local)) {
  vi.spyOn(replica, "replicaReady").mockReturnValue(true);
  vi.spyOn(replica, "replicaFor").mockReturnValue({ search } as unknown as replica.MailboxReplica);
  return search;
}
describe("local-first search queries", () => {
  it("defaults to newest-first and merges remote rows by date", async () => {
    const dated = (id: string, receivedAt: string) =>
      ({ id, threadId: id, subject: id, receivedAt }) as ConversationSummary;
    const search = ready(
      vi.fn().mockResolvedValue({ mode: "lexical", messages: [dated("local", "2025-01-02")] }),
    );
    const remote = vi.spyOn(sentApi, "search").mockResolvedValue({
      mode: "lexical",
      messages: [dated("older", "2025-01-01"), dated("newer", "2025-01-03")],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let result!: ReturnType<typeof useMailSearch>;
    const dispose = render(
      () =>
        createComponent(QueryClientProvider, {
          client,
          get children() {
            return createComponent(() => {
              result = useMailSearch(() => "needle");
              return null;
            }, {});
          },
        }),
      document.createElement("div"),
    );
    cleanup.push(() => {
      dispose();
      client.clear();
    });
    await vi.waitFor(() =>
      expect(result.data?.messages.map((m) => m.id)).toEqual(["newer", "local", "older"]),
    );
    expect(search).toHaveBeenCalledWith("needle", expect.any(Number), "newest");
    expect(remote.mock.calls[0]?.[0].get("sort")).toBe("newest");
  });
  it.each(["", "   "])("clears mail immediately for an empty query %j", async (empty) => {
    const search = ready();
    const remote = vi.spyOn(sentApi, "search");
    const state = scope();
    await vi.waitFor(() => expect(state.result.data).toEqual(local));
    state.setQuery(empty);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.result.data?.messages ?? []).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(state.result.data?.messages ?? []).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
    state.setQuery("needle");
    await vi.waitFor(() => expect(state.result.data).toEqual(local));
  });
  it("paints local results before any request and appends hybrid results without moving rows", async () => {
    ready();
    const remote = vi
      .spyOn(sentApi, "search")
      .mockResolvedValue({ mode: "hybrid", messages: [row("semantic"), row("local")] });
    const state = scope();
    await vi.waitFor(() => expect(state.result.data?.messages[0]?.id).toBe("local"));
    expect(remote).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(state.result.data?.mode).toBe("hybrid"));
    expect(state.result.data?.messages.map((r) => r.id)).toEqual(["local", "semantic"]);
  });
  it("searches offline without pausing and never requests remote refinement", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    onlineManager.setOnline(false);
    ready();
    const remote = vi.spyOn(sentApi, "search");
    const state = scope();
    await vi.waitFor(() => expect(state.result.data).toEqual(local));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(remote).not.toHaveBeenCalled();
  });
  it("retains lexical results on refinement errors", async () => {
    ready();
    let signal: AbortSignal | undefined;
    const remote = vi.spyOn(sentApi, "search").mockImplementation(async (_, s) => {
      signal = s;
      throw Error("offline");
    });
    const state = scope();
    await vi.waitFor(() => expect(remote).toHaveBeenCalled());
    expect(state.result.data).toEqual(local);
    state.setQuery("different");
    await vi.waitFor(() => expect(state.result.data).toEqual(local));
    expect(signal).toBeDefined();
  });
  it("aborts in-flight refinements after the query changes and ignores late replies", async () => {
    ready();
    let signal: AbortSignal | undefined;
    let complete!: (value: SearchResponse) => void;
    vi.spyOn(sentApi, "search")
      .mockImplementationOnce((_, value) => {
        signal = value;
        return new Promise((resolve) => {
          complete = resolve;
        });
      })
      .mockResolvedValue({ mode: "hybrid", messages: [] });
    const state = scope();
    await vi.waitFor(() => expect(signal).toBeDefined());
    state.setQuery("different");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    complete({ mode: "hybrid", messages: [row("obsolete")] });
    await vi.waitFor(() => expect(state.result.data?.messages[0]?.id).toBe("local"));
    expect(
      state.client.getQueryData<SearchResponse>(["search", "needle", "relevance"])?.messages,
    ).toEqual(local.messages);
  });
  it("can refine empty local results with online-only semantic matches", async () => {
    ready(vi.fn().mockResolvedValue({ mode: "lexical", messages: [] }));
    vi.spyOn(sentApi, "search").mockResolvedValue({ mode: "hybrid", messages: [row("semantic")] });
    const state = scope();
    await vi.waitFor(() => expect(state.result.data?.messages).toEqual([]));
    await vi.waitFor(() => expect(state.result.data?.messages[0]?.id).toBe("semantic"));
  });
  it("uses the existing network shape until the replica is ready", async () => {
    vi.spyOn(replica, "replicaReady").mockReturnValue(false);
    const remote = vi.spyOn(sentApi, "search").mockResolvedValue(local);
    const state = scope();
    await vi.waitFor(() => expect(state.result.data).toEqual(local));
    expect(remote).toHaveBeenCalledOnce();
  });
  it("fills the full local page only after two frames and preserves first-page order offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const first = Array.from({ length: 20 }, (_, index) => row(`local-${index}`));
    const full = [
      ...first.map((item) => ({ ...item })),
      ...Array.from({ length: 55 }, (_, index) => row(`rest-${index}`)),
    ];
    const search = ready(
      vi
        .fn()
        .mockResolvedValueOnce({ mode: "lexical", messages: first })
        .mockResolvedValue({ mode: "lexical", messages: full }),
    );
    const state = scope();
    await vi.waitFor(() => expect(state.result.data?.messages).toEqual(first));
    const firstPublished = state.result.data?.messages[0];
    expect(search).toHaveBeenCalledTimes(1);
    frames.shift()?.(0);
    expect(search).toHaveBeenCalledTimes(1);
    frames.shift()?.(16);
    await vi.waitFor(() => expect(state.result.data?.messages).toEqual(full));
    expect(state.result.data?.messages[0]).toBe(firstPublished);
    expect(search).toHaveBeenLastCalledWith("needle", 75, "relevance");
  });
  it("ignores an in-flight local fill after unmount", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const first = Array.from({ length: 20 }, (_, index) => row(`local-${index}`));
    let finish!: (value: SearchResponse) => void;
    const search = ready(
      vi
        .fn()
        .mockResolvedValueOnce({ mode: "lexical", messages: first })
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const state = scope();
    await vi.waitFor(() => expect(state.result.data?.messages).toEqual(first));
    frames.shift()?.(0);
    frames.shift()?.(16);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    state.dispose();
    state.client.clear();
    finish({ mode: "lexical", messages: [row("private-late")] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.client.getQueryData(["search", "needle", "relevance"])).toBeUndefined();
  });
  it("retains the initial page when a local fill fails", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const first = Array.from({ length: 20 }, (_, index) => row(`local-${index}`));
    const search = ready(
      vi
        .fn()
        .mockResolvedValueOnce({ mode: "lexical", messages: first })
        .mockRejectedValue(Error("worker closed")),
    );
    const state = scope();
    await vi.waitFor(() => expect(state.result.data?.messages).toEqual(first));
    frames.shift()?.(0);
    frames.shift()?.(16);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(state.result.data?.messages).toEqual(first);
  });
});
