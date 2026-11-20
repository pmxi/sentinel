import type { ConversationSummary, MessageDetail, MessageSummary } from "@sent/shared";
import type { QueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import { prefetchQuietUntil } from "./mail-cache";
import { messageRead } from "./replica";
import { recentBody } from "./replica-policy";

export function headerData(item?: MessageSummary): MessageDetail | undefined {
  return (
    item && {
      ...item,
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      textBody: "",
      htmlBody: null,
      plainText: null,
      attachments: [],
      internetMessageId: null,
    }
  );
}
export function cachedRow(client: QueryClient, id: string) {
  for (const query of client.getQueryCache().getAll()) {
    if (!["messages", "search"].includes(String(query.queryKey[0]))) continue;
    const row = (
      query.state.data as { messages?: ConversationSummary[] } | undefined
    )?.messages?.find((item) => item.id === id);
    if (row) return row;
  }
}
export function prefetchQueue(client: QueryClient, _trash: boolean) {
  const queued = new Map<string, { item: MessageSummary; readyAt: number }>();
  let stopped = false,
    running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: readonly unknown[] | undefined;
  let activeItem: { id: string; cancelled: boolean } | undefined;
  const pump = async () => {
    timer = undefined;
    if (stopped || running || !queued.size) return;
    if (
      prefetchQuietUntil(client) > Date.now() ||
      client.isFetching({ predicate: (query) => query.getObserversCount() > 0 })
    ) {
      timer = setTimeout(() => void pump(), 150);
      return;
    }
    const next = queued.values().next().value;
    if (!next) return;
    if (next.readyAt > Date.now()) {
      timer = setTimeout(() => void pump(), next.readyAt - Date.now());
      return;
    }
    const item = next.item;
    queued.delete(item.id);
    if (!recentBody(item.receivedAt)) {
      if (queued.size) timer = setTimeout(() => void pump(), 0);
      return;
    }
    running = true;
    const task = { id: item.id, cancelled: false };
    activeItem = task;
    try {
      active = ["message", item.id];
      await client.prefetchQuery({
        queryKey: active,
        queryFn: ({ signal }) => messageRead(client, item.id, signal, true),
        staleTime: 15000,
      });
    } finally {
      active = undefined;
      activeItem = undefined;
      running = false;
      if (!stopped) timer = setTimeout(() => void pump(), 50);
    }
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      !stopped &&
      !running &&
      queued.size
    ) {
      clearTimeout(timer);
      timer = setTimeout(() => void pump(), 0);
    }
  });
  return {
    add(items: MessageSummary[], delay = 120) {
      for (const item of items)
        if (recentBody(item.receivedAt) && activeItem?.id !== item.id)
          queued.set(item.id, {
            item,
            readyAt: Math.min(queued.get(item.id)?.readyAt ?? Infinity, Date.now() + delay),
          });
      if (!timer && !running)
        timer = setTimeout(() => {
          timer = undefined;
          void pump();
        }, delay);
    },
    prioritize(items: MessageSummary[]) {
      queued.clear();
      for (const item of items)
        if (recentBody(item.receivedAt) && activeItem?.id !== item.id)
          queued.set(item.id, { item, readyAt: Date.now() });
      clearTimeout(timer);
      if (!running) timer = setTimeout(() => void pump(), 0);
    },
    foreground(id: string) {
      queued.delete(id);
      if (
        active &&
        activeItem &&
        activeItem.id !== id &&
        !client.getQueryData(["message", id]) &&
        !client.getQueryCache().find({ queryKey: active, exact: true })?.getObserversCount()
      ) {
        activeItem.cancelled = true;
        void client.cancelQueries({ queryKey: active, exact: true });
      }
    },
    stop() {
      stopped = true;
      unsubscribe();
      clearTimeout(timer);
      if (active) void client.cancelQueries({ queryKey: active, exact: true });
    },
  };
}
export function usePrefetch(
  client: QueryClient,
  rows: Accessor<ConversationSummary[]>,
  selected: Accessor<string | null>,
  trash: Accessor<boolean>,
) {
  let queue = prefetchQueue(client, trash());
  createEffect(() => {
    const scope = trash();
    untrack(() => {
      queue.stop();
      queue = prefetchQueue(client, scope);
    });
  });
  createEffect(() => {
    const items = rows(),
      id = selected();
    untrack(() => {
      if (!id) queue.add(items.slice(0, 3));
      else {
        queue.foreground(id);
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0)
          queue.prioritize([
            ...items.slice(index + 1, index + 4),
            ...items.slice(Math.max(0, index - 1), index),
          ]);
      }
    });
  });
  onCleanup(() => queue.stop());
  return (item: MessageSummary) => queue.add([item], 100);
}
