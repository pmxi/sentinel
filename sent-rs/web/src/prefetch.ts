import type { ConversationSummary, MessageDetail, MessageSummary } from "@sent/shared";
import type { QueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import { sentApi } from "./api";
import { prefetchQuietUntil } from "./mail-cache";

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
export function prefetchQueue(client: QueryClient, trash: boolean) {
  const queued = new Map<string, MessageSummary>();
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
      client.isMutating() ||
      client.isFetching({ predicate: (query) => query.getObserversCount() > 0 })
    ) {
      timer = setTimeout(() => void pump(), 150);
      return;
    }
    const item = queued.values().next().value;
    if (!item) return;
    queued.delete(item.id);
    running = true;
    const task = { id: item.id, cancelled: false };
    activeItem = task;
    try {
      active = ["thread", item.threadId, trash];
      await client.prefetchQuery({
        queryKey: active,
        queryFn: ({ signal }) => sentApi.thread(item.threadId, trash, signal),
        staleTime: 15000,
      });
      if (task.cancelled || stopped) return;
      const thread = client.getQueryData<{ messages: MessageDetail[] }>(active);
      for (const message of thread?.messages ?? [])
        client.setQueryData(["message", message.id], message);
      active = ["message", item.id];
      await client.prefetchQuery({
        queryKey: active,
        queryFn: ({ signal }) => sentApi.message(item.id, signal),
        staleTime: 15000,
      });
    } finally {
      active = undefined;
      activeItem = undefined;
      running = false;
      if (!stopped) timer = setTimeout(() => void pump(), 50);
    }
  };
  return {
    add(items: MessageSummary[], delay = 120) {
      for (const item of items) queued.set(item.id, item);
      if (!timer && !running)
        timer = setTimeout(() => {
          timer = undefined;
          void pump();
        }, delay);
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
          queue.add(
            items.slice(Math.max(0, index - 1), index + 4).filter((item) => item.id !== id),
          );
      }
    });
  });
  onCleanup(() => queue.stop());
  return (item: MessageSummary) => queue.add([item], 100);
}
