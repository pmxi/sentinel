import type { ConversationSummary, MessageListResponse } from "@sent/shared";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { quietUntil } from "./mail-cache";
import { mailboxRead, replicaReady } from "./replica";

export type MailboxPage = MessageListResponse & { pageCount: number };
export function distinctRows(rows: ConversationSummary[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.threadId)) return false;
    seen.add(row.threadId);
    return true;
  });
}
export async function refreshPages(
  load: (cursor?: string) => Promise<MessageListResponse>,
  count: number,
): Promise<MailboxPage> {
  const messages: ConversationSummary[] = [];
  let cursor: string | undefined;
  for (let pageCount = 1; pageCount <= Math.max(1, count); pageCount++) {
    const page = await load(cursor);
    if (page.nextCursor && page.nextCursor === cursor)
      throw new Error("Mail pagination did not advance");
    messages.push(...page.messages);
    cursor = page.nextCursor ?? undefined;
    if (!cursor || pageCount === Math.max(1, count))
      return { messages: distinctRows(messages), nextCursor: cursor ?? null, pageCount };
  }
  throw new Error("Invalid page count");
}
export function useMailbox(view: Accessor<string>, accountId: Accessor<string | undefined>) {
  const client = useQueryClient();
  const key = createMemo(() => ["messages", view(), accountId()] as const);
  const scope = createMemo(() => JSON.stringify(key()));
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let active: { scope: string; controller: AbortController; promise: Promise<void> } | undefined;
  const params = () => {
    const result = new URLSearchParams({ view: view(), limit: "75" });
    const account = accountId();
    if (account) result.set("accountId", account);
    return result;
  };
  createEffect(() => {
    const current = scope();
    untrack(() => {
      if (active && active.scope !== current) {
        active.controller.abort();
        active = undefined;
      }
      setLoadingMore(false);
      setError(undefined);
    });
  });
  onCleanup(() => active?.controller.abort());
  const query = createQuery(() => ({
    queryKey: key(),
    networkMode: "always",
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const input = params();
      return refreshPages((cursor) => {
        const page = new URLSearchParams(input);
        if (cursor) page.set("cursor", cursor);
        return mailboxRead(client, page, signal);
      }, client.getQueryData<MailboxPage>(key())?.pageCount ?? 1);
    },
    refetchInterval:
      replicaReady(client) || loadingMore() || quietUntil(client) > Date.now() ? false : 4000,
    reconcile: "threadId",
  }));
  const loadMore = (): Promise<void> => {
    if (active?.scope === scope()) return active.promise;
    const queryKey = key(),
      current = client.getQueryData<MailboxPage>(queryKey);
    if (!current?.nextCursor) return Promise.resolve();
    const cursor = current.nextCursor,
      input = params();
    input.set("cursor", cursor);
    setLoadingMore(true);
    setError(undefined);
    const request = {
      scope: scope(),
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    active = request;
    request.promise = (async () => {
      try {
        await client.cancelQueries({ queryKey, exact: true });
        if (request.controller.signal.aborted) return;
        const page = await mailboxRead(client, input, request.controller.signal);
        if (request.controller.signal.aborted) return;
        if (page.nextCursor === cursor) throw new Error("Mail pagination did not advance");
        client.setQueryData<MailboxPage>(queryKey, (previous) =>
          !previous || previous.nextCursor !== cursor
            ? previous
            : {
                messages: distinctRows([...previous.messages, ...page.messages]),
                nextCursor: page.nextCursor,
                pageCount: (previous.pageCount ?? 1) + 1,
              },
        );
      } catch (reason) {
        if (active === request && !request.controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Couldn’t load more mail");
      } finally {
        if (active === request) {
          active = undefined;
          setLoadingMore(false);
        }
      }
    })();
    return request.promise;
  };
  return { query, loadMore, loadingMore, error };
}
