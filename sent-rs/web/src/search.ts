import type { SearchResponse } from "@sent/shared";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { sentApi } from "./api";
import { replicaFor, replicaReady } from "./replica";
import { refineSearch } from "./replica-search";

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

export function useMailSearch(query: Accessor<string>) {
  const client = useQueryClient();
  const [debounced, setDebounced] = createSignal(query());
  let generation = 0;
  let lastQuery = query();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests = new Set<AbortController>();
  const fills = new Set<() => void>();
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
    queryKey: ["search", client.getQueryData(["search", query()]) ? query() : debounced()],
    networkMode: "always",
    refetchOnReconnect: "always",
    queryFn: async ({ queryKey, signal }) => {
      const current = generation;
      const text = String(queryKey[1]);
      const params = new URLSearchParams({ q: text, limit: "75" });
      const replica = replicaFor(client);
      if (!replicaReady(client) || !replica) return sentApi.search(params, signal);
      let local: SearchResponse;
      const visiblePage = Math.min(75, Math.max(20, Math.ceil(window.innerHeight / 64) + 4));
      const cached = client.getQueryData<SearchResponse>(queryKey);
      const firstPage = cached && cached.messages.length > visiblePage ? 75 : visiblePage;
      try {
        local = await replica.search(text, firstPage);
      } catch (error) {
        if (navigator.onLine === false) throw error;
        return sentApi.search(params, signal);
      }
      if (current !== generation || signal.aborted) return local;
      if (local.messages.length === firstPage && firstPage < 75) {
        let cancelled = false;
        const cancelPaint = afterPaint(async () => {
          try {
            if (cancelled || current !== generation || signal.aborted) return;
            const full = await replica.search(text, 75);
            if (!cancelled && current === generation && !signal.aborted)
              client.setQueryData<SearchResponse>(queryKey, (previous) => ({
                ...refineSearch(previous ?? local, full),
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
        if (current !== generation || signal.aborted || navigator.onLine === false) return;
        const controller = new AbortController();
        requests.add(controller);
        try {
          const remote = await sentApi.search(params, controller.signal);
          if (current === generation && !controller.signal.aborted)
            client.setQueryData<SearchResponse>(queryKey, (previous) =>
              refineSearch(previous ?? local, remote),
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
      Boolean(query()) &&
      (query() === debounced() || Boolean(client.getQueryData(["search", query()]))),
    placeholderData: (previous) => previous,
    reconcile: "threadId",
  }));
}
