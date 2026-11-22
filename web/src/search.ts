import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { sentApi } from "./api";
import { replicaFor, replicaReady } from "./replica";
import { refineSearch } from "./replica-search";
import type { SearchResponse, SearchSort } from "./shared";

function afterPaint(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      timer = setTimeout(run, 0);
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

function keepRelevanceOrder(previous: SearchResponse, next: SearchResponse): SearchResponse {
  const positions = new Map(previous.messages.map(({ threadId }, index) => [threadId, index]));
  const position = (id: string) => positions.get(id) ?? positions.size;
  return {
    ...next,
    messages: [...next.messages].sort((a, b) => position(a.threadId) - position(b.threadId)),
  };
}

export function useMailSearch(
  query: Accessor<string>,
  sort: Accessor<SearchSort> = () => "newest",
) {
  const client = useQueryClient();
  const [debounced, setDebounced] = createSignal(query());
  let generation = 0;
  let lastQuery = query();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests = new Set<AbortController>();
  const fills = new Set<() => void>();
  const runs = new Map<SearchSort, symbol>();
  createEffect(() => {
    const value = query();
    if (value !== lastQuery) {
      generation++;
      lastQuery = value;
    }
    const timer = setTimeout(() => setDebounced(value), 150);
    onCleanup(() => {
      clearTimeout(timer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const request of requests) request.abort();
      requests.clear();
      for (const cancel of fills) cancel();
      fills.clear();
    });
  });
  return createQuery<SearchResponse>(() => ({
    queryKey: ["search", query().trim() ? query() : "", sort()],
    networkMode: "always",
    refetchOnReconnect: "always",
    queryFn: async ({ queryKey, signal }) => {
      const current = generation;
      const text = String(queryKey[1]);
      const order = queryKey[2] as SearchSort;
      const run = Symbol();
      runs.set(order, run);
      const isCurrent = () => current === generation && runs.get(order) === run && !signal.aborted;
      const params = new URLSearchParams({ q: text, limit: "75", sort: order });
      const replica = replicaFor(client);
      if (!replicaReady(client) || !replica) return sentApi.search(params, signal);
      let local: SearchResponse;
      const visiblePage = Math.min(75, Math.max(20, Math.ceil(window.innerHeight / 64) + 4));
      const cached = client.getQueryData<SearchResponse>(queryKey);
      const displayed = order === "relevance" && cached?.messages.length ? cached : undefined;
      const firstPage =
        displayed || (cached && cached.messages.length > visiblePage) ? 75 : visiblePage;
      try {
        local = await replica.search(text, firstPage, order);
      } catch (error) {
        if (navigator.onLine === false) throw error;
        const remote = await sentApi.search(params, signal);
        return displayed ? keepRelevanceOrder(displayed, remote) : remote;
      }
      if (!isCurrent()) return local;
      if (displayed) {
        // Publishing the local snapshot first would temporarily remove hosted-only matches.
        if (navigator.onLine !== false) {
          try {
            local = refineSearch(local, await sentApi.search(params, signal), order);
          } catch (error) {
            if (signal.aborted) throw error;
          }
        }
        return keepRelevanceOrder(displayed, local);
      }
      if (local.messages.length === firstPage && firstPage < 75) {
        let cancelled = false;
        const cancelPaint = afterPaint(async () => {
          try {
            if (cancelled || !isCurrent()) return;
            const full = await replica.search(text, 75, order);
            if (!cancelled && isCurrent())
              client.setQueryData<SearchResponse>(queryKey, (previous) => ({
                ...refineSearch(previous ?? local, full, order),
                mode: previous?.mode ?? full.mode,
              }));
          } catch {
          } finally {
            fills.delete(cancel);
          }
        });
        const cancel = () => {
          cancelled = true;
          cancelPaint();
        };
        fills.add(cancel);
      }
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (!isCurrent() || navigator.onLine === false) return;
        const controller = new AbortController();
        requests.add(controller);
        try {
          const remote = await sentApi.search(params, controller.signal);
          if (isCurrent() && !controller.signal.aborted)
            client.setQueryData<SearchResponse>(queryKey, (previous) =>
              refineSearch(previous ?? local, remote, order),
            );
        } catch {
        } finally {
          requests.delete(controller);
        }
      }, 200);
      timers.add(timer);
      return local;
    },
    enabled:
      Boolean(query().trim()) &&
      (query() === debounced() || Boolean(client.getQueryData(["search", query(), sort()]))),
    reconcile: "threadId",
  }));
}
