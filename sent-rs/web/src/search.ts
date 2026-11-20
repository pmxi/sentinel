import type { SearchResponse } from "@sent/shared";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { sentApi } from "./api";
import { replicaFor, replicaReady } from "./replica";
import { refineSearch } from "./replica-search";

export function useMailSearch(query: Accessor<string>) {
  const client = useQueryClient();
  const [debounced, setDebounced] = createSignal(query());
  let generation = 0;
  let lastQuery = query();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests = new Set<AbortController>();
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
      try {
        local = await replica.search(text);
      } catch (error) {
        if (navigator.onLine === false) throw error;
        return sentApi.search(params, signal);
      }
      if (current !== generation || signal.aborted) return local;
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
