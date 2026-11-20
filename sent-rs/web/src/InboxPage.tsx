import type {
  Account,
  ConversationSummary,
  MessageDetail,
  MessageSummary,
  SearchResponse,
  Tier,
} from "@sent/shared";
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { Archive, Flag, Mail, MailOpen, Paperclip, Trash2 } from "lucide-solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { sentApi } from "./api";
import { useCommands, useFrameCommands } from "./commands";
import { replySeed, useCompose } from "./compose";
import { messageCursorIndex, nextMessageIndex } from "./keyboard";
import { MessagePreview, RankingReason, ReaderInsights } from "./MessageInsights";
import { optimistic, quietUntil } from "./mail-cache";
import { cachedRow, headerData, usePrefetch } from "./prefetch";
import { ReaderText } from "./ReaderText";
import { useLocation, useNavigate, useParams, useSearchParams } from "./router";
import { nextMessageId, useTriage, visibleConversations } from "./triage";

function useMessageNavigation<Message extends MessageSummary>(messages: Accessor<Message[]>) {
  const location = useLocation();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const triage = useTriage();
  const snapshot = createMemo(() => {
    const pathname = location.pathname;
    const search = location.search;
    const visible = visibleConversations(messages(), triage.hiddenThreadIds);
    const order = visible.map(({ id }) => ({ id }));
    return {
      visible,
      restore: (id: string) => {
        const next = new URLSearchParams(search);
        next.set("message", id);
        navigate({ pathname, search: next.toString() });
      },
      advance: (id: string) => {
        if (window.location.pathname !== pathname) return;
        const nextId = nextMessageId(order, id);
        setParams(
          (current) => {
            if (current.get("message") !== id) return current;
            const next = new URLSearchParams(current);
            if (nextId) next.set("message", nextId);
            else next.delete("message");
            return next;
          },
          { replace: true },
        );
      },
    };
  });
  return {
    get visible() {
      return snapshot().visible;
    },
    get advance() {
      return snapshot().advance;
    },
    get restore() {
      return snapshot().restore;
    },
  };
}
const viewDetails: Record<
  string,
  {
    title: string;
  }
> = {
  l1: { title: "Important" },
  l2: { title: "Updates" },
  l3: { title: "Low priority" },
  unclassified: { title: "Sorting" },
  all: { title: "All mail" },
  sent: { title: "Sent" },
  trash: { title: "Trash" },
};
export function InboxPage(props: { accounts: Account[] }) {
  const client = useQueryClient();
  const route = useParams();
  const [params, setParams] = useSearchParams();
  const selectedId = createMemo(() => params().get("message"));
  const accountId = createMemo(() => params().get("account") ?? undefined);
  const query = createMemo(() => {
    const value = new URLSearchParams({ view: route.view ?? "l1", limit: "75" });
    const account = accountId();
    if (account) value.set("accountId", account);
    return value;
  });
  const messages = createQuery(() => ({
    queryKey: ["messages", route.view ?? "l1", accountId()],
    queryFn: () => sentApi.messages(query()),
    refetchInterval: () => (quietUntil(client) > Date.now() ? false : 4000),
    reconcile: "threadId",
  }));
  const detail = createMemo(() => viewDetails[route.view ?? "l1"] ?? viewDetails.all);
  const navigation = useMessageNavigation(() => messages.data?.messages ?? []);
  const prefetch = usePrefetch(
    client,
    () => navigation.visible,
    selectedId,
    () => route.view === "trash",
  );
  const select = (message: MessageSummary) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("message", message.id);
      return next;
    });
  };
  return (
    <>
      {
        <div class={`mail-layout ${selectedId() ? "has-reader" : ""}`}>
          <section class="message-pane">
            <header class="pane-heading">
              <div>
                <h1>{detail()?.title}</h1>
              </div>
              {props.accounts.length > 1 && (
                <select
                  value={accountId() ?? ""}
                  onInput={(event) => {
                    const next = new URLSearchParams(params());
                    if (event.currentTarget.value) next.set("account", event.currentTarget.value);
                    else next.delete("account");
                    next.delete("message");
                    setParams(next);
                  }}
                >
                  <option value="">All accounts</option>
                  {props.accounts.map((account) => (
                    <option value={account.id}>{account.email}</option>
                  ))}
                </select>
              )}
            </header>
            <MessageList
              prefetch={prefetch}
              messages={navigation.visible}
              loading={messages.isLoading}
              error={messages.error?.message}
              selectedId={selectedId()}
              onSelect={select}
            />
          </section>
          <Show when={selectedId()} keyed fallback={<EmptyReader />}>
            {(id) => (
              <Reader
                messageId={id}
                summary={messages.data?.messages.find((item) => item.id === id)}
                accounts={props.accounts}
                advance={navigation.advance.bind(null, id)}
                restore={navigation.restore.bind(null, id)}
                close={() => {
                  const next = new URLSearchParams(params());
                  next.delete("message");
                  setParams(next);
                }}
              />
            )}
          </Show>
        </div>
      }
    </>
  );
}
export function SearchResults(props: { accounts: Account[] }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = createMemo(() => params().get("q") ?? "");
  const [debounced, setDebounced] = createSignal(q());
  createEffect(() => {
    const value = q();
    const timer = setTimeout(() => setDebounced(value), 150);
    onCleanup(() => clearTimeout(timer));
  });
  const selectedId = createMemo(() => params().get("message"));
  const result = createQuery<SearchResponse>(() => ({
    queryKey: ["search", client.getQueryData(["search", q()]) ? q() : debounced()],
    queryFn: ({ queryKey }) =>
      sentApi.search(new URLSearchParams({ q: String(queryKey[1]), limit: "75" })),
    enabled: Boolean(q()) && (q() === debounced() || Boolean(client.getQueryData(["search", q()]))),
    placeholderData: (previous) => previous,
    reconcile: "threadId",
  }));
  const navigation = useMessageNavigation(() => result.data?.messages ?? []);
  const prefetch = usePrefetch(
    client,
    () => navigation.visible,
    selectedId,
    () => false,
  );
  return (
    <>
      {
        <div class={`mail-layout ${selectedId() ? "has-reader" : ""}`}>
          <section class="message-pane">
            <header class="pane-heading">
              <div>
                <h1>Search</h1>
                <p>
                  {result.data
                    ? `${q()} · ${result.data.messages.length} ${result.data.messages.length === 1 ? "conversation" : "conversations"}`
                    : q()}
                </p>
              </div>
            </header>
            <MessageList
              prefetch={prefetch}
              messages={navigation.visible}
              loading={result.isLoading}
              error={result.error?.message}
              selectedId={selectedId()}
              onSelect={(message) => {
                const next = new URLSearchParams(params());
                next.set("message", message.id);
                setParams(next);
              }}
            />
          </section>
          <Show when={selectedId()} keyed fallback={<EmptyReader />}>
            {(id) => (
              <Reader
                messageId={id}
                summary={result.data?.messages.find((item) => item.id === id)}
                accounts={props.accounts}
                advance={navigation.advance.bind(null, id)}
                restore={navigation.restore.bind(null, id)}
                close={() => {
                  const next = new URLSearchParams(params());
                  next.delete("message");
                  setParams(next);
                }}
              />
            )}
          </Show>
        </div>
      }
    </>
  );
}
function MessageList(props: {
  prefetch?(message: ConversationSummary): void;
  messages: ConversationSummary[];
  loading: boolean;
  error?: string;
  selectedId: string | null;
  onSelect(message: MessageSummary): void;
}) {
  const list = { current: null } as {
    current: HTMLDivElement | null;
  };
  const [cursorThreadId, setCursorThreadId] = createSignal<string | null>(null);
  const currentIndex = createMemo(() =>
    messageCursorIndex(props.messages, props.selectedId, cursorThreadId()),
  );
  const move = (direction: number) => {
    const index = nextMessageIndex(props.messages.length, currentIndex(), direction);
    const message = props.messages[index];
    if (!message) return;
    setCursorThreadId(message.threadId);
    list.current
      ?.querySelectorAll<HTMLButtonElement>(".message-row")
      [index]?.focus({ preventScroll: true });
    list.current
      ?.querySelectorAll<HTMLButtonElement>(".message-row")
      [index]?.scrollIntoView({ block: "nearest" });
    if (props.selectedId && props.selectedId !== message.id) props.onSelect(message);
  };
  useCommands("list", () => [
    {
      id: "next",
      label: "Next message",
      group: "Mail",
      keys: ["j"],
      run: () => move(1),
      disabled: !props.messages.length,
    },
    {
      id: "previous",
      label: "Previous message",
      group: "Mail",
      keys: ["k"],
      run: () => move(-1),
      disabled: !props.messages.length,
    },
    {
      id: "open",
      label: "Open selected message",
      group: "Mail",
      keys: ["Enter"],
      run: () => {
        const message = props.messages[currentIndex()] ?? props.messages[0];
        if (message) props.onSelect(message);
      },
      disabled: !props.messages.length || Boolean(props.selectedId),
    },
  ]);
  return (
    <Switch>
      <Match when={props.loading}>
        {
          <div class="message-loading">
            {["one", "two", "three", "four", "five", "six", "seven", "eight"].map((_key) => (
              <div class="skeleton-row" />
            ))}
          </div>
        }
      </Match>
      <Match when={props.error}>
        {
          <div class="empty-list">
            <strong>Couldn’t load mail</strong>
            <span>{props.error}</span>
          </div>
        }
      </Match>
      <Match when={props.messages.length === 0}>
        {
          <div class="empty-list">
            <strong>No messages</strong>
          </div>
        }
      </Match>
      <Match when={true}>
        {
          <div
            class="message-list"
            ref={(element) => {
              list.current = element;
            }}
          >
            <For each={props.messages}>
              {(message) => (
                <div
                  class={`message-list-item ${props.selectedId === message.id ? "selected" : ""}`}
                >
                  <button
                    aria-current={props.selectedId === message.id ? "true" : undefined}
                    onFocus={() => {
                      setCursorThreadId(message.threadId);
                      props.prefetch?.(message);
                    }}
                    onMouseEnter={() => props.prefetch?.(message)}
                    class={`message-row ${!message.read ? "unread" : ""} ${message.tier === null && message.direction === "inbound" ? "unclassified" : ""} ${props.selectedId === message.id ? "selected" : ""}`}
                    onClick={() => props.onSelect(message)}
                  >
                    <span class="message-copy">
                      <span class="message-line">
                        <span class="conversation-senders">
                          <strong>
                            {message.participants
                              .map((person) =>
                                person.address.toLowerCase() === message.account.email.toLowerCase()
                                  ? "Me"
                                  : person.name || person.address,
                              )
                              .join(", ") || "Unknown"}
                          </strong>
                          {message.messageCount > 1 && (
                            <span
                              class="conversation-count"
                              title={`${message.messageCount} messages`}
                            >
                              {message.messageCount}
                              <span class="visually-hidden"> messages</span>
                            </span>
                          )}
                        </span>
                        <time>{formatListDate(message.receivedAt)}</time>
                      </span>
                      <span class="message-subject">
                        {message.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") || "(No subject)"}
                      </span>
                      <MessagePreview message={message} />
                      <span class="message-meta">
                        {message.account.email}
                        {message.unreadCount > 0 && (
                          <span class="conversation-unread">{message.unreadCount} unread</span>
                        )}
                        {message.attachmentCount > 0 && (
                          <>
                            <Paperclip size={12} />
                            {message.attachmentCount}
                          </>
                        )}
                        {message.tier === null && message.direction === "inbound" && (
                          <span class="sorting-label">Sorting…</span>
                        )}
                        {message.syncPending && <span>Syncing…</span>}
                      </span>
                    </span>
                    {message.flagged && <Flag class="row-flag" size={14} fill="currentColor" />}
                  </button>
                  <RankingReason message={message} />
                </div>
              )}
            </For>
          </div>
        }
      </Match>
    </Switch>
  );
}
function Reader(props: {
  messageId: string;
  summary?: MessageSummary;
  accounts: Account[];
  close(): void;
  advance(): void;
  restore(): void;
}) {
  const queryClient = useQueryClient();
  const compose = useCompose();
  const route = useParams();
  const trash = createMemo(() => route.view === "trash");
  const [params] = useSearchParams();
  const triage = useTriage();
  const [bodyView, setBodyView] = createSignal<"plain" | "original">("plain");
  const [hasShownFallback, setHasShownFallback] = createSignal(false);
  const newestRef = { current: null } as {
    current: HTMLElement | null;
  };
  const openedMessages = { current: new Set<string>() };
  const scrolledToNewest = { current: false };
  const detail = createQuery<MessageDetail>(() => ({
    queryKey: ["message", props.messageId],
    queryFn: ({ signal }) => sentApi.message(props.messageId, signal),
    placeholderData: headerData(props.summary ?? cachedRow(queryClient, props.messageId)),
  }));
  const threadId = createMemo(() => props.summary?.threadId ?? detail.data?.threadId);
  const thread = createQuery(() => ({
    queryKey: ["thread", threadId(), trash()],
    queryFn: ({ signal }) => sentApi.thread(threadId() ?? "", trash(), signal),
    enabled: Boolean(threadId()),
    refetchInterval: () => (quietUntil(queryClient) > Date.now() ? false : 4000),
  }));
  const orderedMessages = createMemo(
    () => thread.data?.messages ?? (detail.data ? [detail.data] : []),
  );
  const readerLoading = createMemo(() => !thread.data && !detail.data && !hasShownFallback());
  const headerOnly = createMemo(() => detail.isPlaceholderData && !thread.data);
  // Do not expose actions for the selected fallback while the newest reply is loading.
  const message = createMemo(() => (readerLoading() ? undefined : orderedMessages().at(-1)));
  const conversation = createMemo(() => orderedMessages().slice(0, -1));
  const actionOptions = () => ({
    mutationFn: ({ id, action }: { id: string; action: string }) => sentApi.action(id, action),
    onMutate: (input: { id: string; action: string }) => optimistic(queryClient, input),
    onSuccess: (
      result: Awaited<ReturnType<typeof sentApi.action>>,
      _input: { id: string; action: string },
      transaction: ReturnType<typeof optimistic> | undefined,
    ) => transaction?.commit(result),
    onError: (
      _error: Error,
      _input: { id: string; action: string },
      transaction: ReturnType<typeof optimistic> | undefined,
    ) => transaction?.rollback(),
  });
  const action = createMutation(actionOptions);
  const markRead = createMutation(actionOptions);
  const tier = createMutation(() => ({
    mutationFn: (input: { id: string; tier: Tier }) => sentApi.tier(input.id, input.tier),
    onMutate: (input: { id: string; tier: Tier }) => optimistic(queryClient, input),
    onSuccess: (result, _input, transaction) => transaction?.commit(result),
    onError: (_error, _input, transaction) => transaction?.rollback(),
  }));
  const account = createMemo(() =>
    props.accounts.find((item) => item.id === message()?.account.id),
  );
  const doAction = (value: string, shouldClose = false) => {
    const item = message();
    if (!item) return;
    action.mutate(
      { id: item.id, action: value },
      { onSuccess: shouldClose ? props.close : undefined },
    );
  };
  const triageAction = (action: "archive" | "delete") => {
    const item = message();
    if (item && (thread.data || thread.isError))
      triage.perform(
        item.threadId,
        action,
        props.advance,
        props.restore,
        route.view ?? "all",
        params().get("account") ?? undefined,
      );
  };
  const reply = (all = false) => {
    const item = message();
    const owner = account();
    if (item && owner)
      compose.openCompose({
        ...replySeed(item, owner, all),
        onSent: props.advance,
        onUndo: props.restore,
      });
  };
  const forward = () => {
    const item = message();
    if (!item) return;
    compose.openCompose({
      accountId: item.account.id,
      subject: item.subject.toLowerCase().startsWith("fwd:")
        ? item.subject
        : `Fwd: ${item.subject}`,
      body: `\n\n---------- Forwarded message ----------\nFrom: ${item.from[0]?.name || item.from[0]?.address}\nDate: ${new Date(item.receivedAt).toLocaleString()}\nSubject: ${item.subject}\n\n${item.textBody}`,
      forwardOfMessageId: item.id,
    });
  };
  const unavailable = createMemo(
    () => !message() || headerOnly() || action.isPending || (!thread.data && !thread.isError),
  );
  useCommands("reader", () => [
    {
      id: "archive",
      label: "Archive message",
      group: "Message",
      keys: ["e"],
      run: () => triageAction("archive"),
      disabled: unavailable(),
    },
    {
      id: "delete",
      label: "Move message to Trash",
      group: "Message",
      keys: ["#"],
      run: () => triageAction("delete"),
      disabled: unavailable(),
    },
    {
      id: "reply",
      label: "Reply",
      group: "Message",
      keys: ["r"],
      run: () => reply(),
      disabled: !message() || headerOnly() || !account(),
    },
    {
      id: "reply-all",
      label: "Reply all",
      group: "Message",
      keys: ["a"],
      run: () => reply(true),
      disabled: !message() || headerOnly() || !account(),
    },
    {
      id: "forward",
      label: "Forward message",
      group: "Message",
      keys: ["f"],
      run: forward,
      disabled: !message() || headerOnly(),
    },
    {
      id: "read",
      label: message()?.read ? "Mark as unread" : "Mark as read",
      group: "Message",
      keys: ["u"],
      run: () => doAction(message()?.read ? "mark_unread" : "mark_read", Boolean(message()?.read)),
      disabled: unavailable(),
    },
    {
      id: "flag",
      label: message()?.flagged ? "Unflag message" : "Flag message",
      group: "Message",
      keys: ["s"],
      run: () => doAction(message()?.flagged ? "unflag" : "flag"),
      disabled: unavailable(),
    },
    {
      id: "back",
      label: "Back to message list",
      group: "Message",
      keys: ["Escape"],
      run: props.close,
    },
  ]);
  createEffect(() => {
    [thread.data, thread.isError, detail.data, markRead.mutate];
    const cleanup = untrack(() => {
      if (thread.isError) setHasShownFallback(true);
      const visible = thread.data?.messages ?? (thread.isError && detail.data ? [detail.data] : []);
      for (const item of visible) {
        if (openedMessages.current.has(item.id)) continue;
        openedMessages.current.add(item.id);
        if (!item.read) markRead.mutate({ id: item.id, action: "mark_read" });
      }
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  createEffect(() => {
    [thread.data];
    const cleanup = untrack(() => {
      if (!thread.data || scrolledToNewest.current || !newestRef.current) return;
      scrolledToNewest.current = true;
      newestRef.current.scrollIntoView({ block: "nearest" });
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  const hasPlainText = createMemo(() =>
    [message(), ...conversation()].some((item) => Boolean(item?.plainText?.trim())),
  );
  return (
    <Switch>
      <Match when={readerLoading()}>
        {
          <section class="reader">
            <div class="reader-skeleton" />
          </section>
        }
      </Match>
      <Match when={!message()}>
        {
          <section class="reader">
            <button class="back-button" onClick={props.close}>
              Back
            </button>
            <div class="empty-list">Message unavailable.</div>
          </section>
        }
      </Match>
      <Match when={message()}>
        {(current) => (
          <section class="reader">
            <header class="reader-toolbar">
              <button class="back-button" onClick={props.close}>
                <span>Back</span>
              </button>
              <div class="toolbar-actions">
                <TierPicker
                  disabled={headerOnly()}
                  tier={current().tier}
                  onChange={(value) => tier.mutate({ id: current().id, tier: value })}
                />
                <button
                  class="icon-button"
                  title="Archive conversation"
                  disabled={headerOnly()}
                  aria-label="Archive conversation"
                  onClick={() => triageAction("archive")}
                >
                  <Archive size={18} />
                </button>
                <button
                  class="icon-button"
                  title="Delete conversation"
                  disabled={headerOnly()}
                  aria-label="Delete conversation"
                  onClick={() => triageAction("delete")}
                >
                  <Trash2 size={18} />
                </button>
                <button
                  class="icon-button"
                  title={current().read ? "Mark unread" : "Mark read"}
                  disabled={headerOnly()}
                  onClick={() => doAction(current().read ? "mark_unread" : "mark_read")}
                >
                  {current().read ? <Mail size={18} /> : <MailOpen size={18} />}
                </button>
                <button
                  class={`icon-button ${current().flagged ? "active" : ""}`}
                  title="Flag"
                  disabled={headerOnly()}
                  onClick={() => doAction(current().flagged ? "unflag" : "flag")}
                >
                  <Flag size={18} fill={current().flagged ? "currentColor" : "none"} />
                </button>
              </div>
            </header>
            {action.error && (
              <p class="compose-error" role="alert">
                {action.error.message}
              </p>
            )}
            <article class="message-reader">
              <header class="conversation-heading">
                <h2>
                  {current().subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") || "(No subject)"}
                </h2>
                <p>
                  {orderedMessages().length}{" "}
                  {orderedMessages().length === 1 ? "message" : "messages"} ·{" "}
                  {current().account.email}
                </p>
              </header>
              {thread.isError && (
                <p role="status">
                  {thread.data
                    ? "Couldn’t refresh the conversation. Showing saved messages."
                    : "Couldn’t load the conversation. Showing the selected message."}
                </p>
              )}
              {hasPlainText() && (
                <nav class="body-view-picker" aria-label="Message body view">
                  <button
                    class={bodyView() === "plain" ? "active" : ""}
                    onClick={() => setBodyView("plain")}
                  >
                    Plain text
                  </button>
                  <button
                    class={bodyView() === "original" ? "active" : ""}
                    onClick={() => setBodyView("original")}
                  >
                    Original
                  </button>
                </nav>
              )}
              {conversation().length > 0 && (
                <div class="thread-history">
                  <span class="section-label">Earlier in this conversation</span>
                  {conversation().map((item) => (
                    <details class="thread-message">
                      <summary>
                        <span>
                          <strong>
                            {item.from[0]?.name || item.from[0]?.address || "Unknown"}
                          </strong>
                          <small>{item.snippet}</small>
                        </span>
                        <time>{formatListDate(item.receivedAt)}</time>
                      </summary>
                      <MessageBody
                        message={item}
                        view={bodyView()}
                        title={`Message from ${item.from[0]?.name || item.from[0]?.address || "sender"}`}
                      />
                      <MessageAttachments message={item} />
                    </details>
                  ))}
                </div>
              )}
              <section
                class="latest-message"
                ref={(element) => {
                  newestRef.current = element;
                }}
                aria-label="Latest message"
              >
                <div class="latest-message-heading">
                  <strong>
                    {current().from[0] ? formatAddress(current().from[0]) : "Unknown sender"}
                  </strong>
                  <time dateTime={current().receivedAt}>
                    {new Date(current().receivedAt).toLocaleString()}
                  </time>
                </div>
                <p class="latest-recipients">
                  To: {current().to.map(formatAddress).join(", ") || "me"}
                </p>
                {conversation().length > 0 && <span class="latest-label">Latest message</span>}
                <ReaderInsights message={current()} />
                <Show
                  when={thread.data || !detail.isPlaceholderData}
                  fallback={<div class="reader-skeleton" />}
                >
                  <div class="email-body">
                    <MessageBody message={current()} view={bodyView()} title="Email content" />
                  </div>
                </Show>
                <MessageAttachments message={current()} />
              </section>
              <div class="reply-actions">
                <button disabled={headerOnly()} onClick={() => reply()}>
                  Reply
                </button>
                <button disabled={headerOnly()} onClick={() => reply(true)}>
                  Reply all
                </button>
                <button disabled={headerOnly()} onClick={forward}>
                  Forward
                </button>
              </div>
            </article>
          </section>
        )}
      </Match>
    </Switch>
  );
}
export function MessageAttachments(props: { message: Pick<MessageDetail, "id" | "attachments"> }) {
  return (
    <>
      {(() => {
        if (props.message.attachments.length === 0) return null;
        return (
          <div class="attachments">
            <span class="section-label">Attachments</span>
            <div>
              {props.message.attachments.map((item) => (
                <a
                  href={`/api/messages/${props.message.id}/attachments/${encodeURIComponent(item.id)}`}
                >
                  <Paperclip size={15} />
                  <span>
                    {item.filename}
                    <small>{formatBytes(item.size)}</small>
                  </span>
                </a>
              ))}
            </div>
          </div>
        );
      })()}
    </>
  );
}
function MessageBody(props: { message: MessageDetail; view: "plain" | "original"; title: string }) {
  return (
    <>
      {(() => {
        if (props.view === "plain" && props.message.plainText?.trim())
          return <ReaderText text={props.message.plainText} />;
        if (props.message.htmlBody)
          return <EmailFrame title={props.title} html={props.message.htmlBody} />;
        return <div class="plain-body">{props.message.textBody}</div>;
      })()}
    </>
  );
}
function TierPicker(props: { tier: Tier | null; disabled?: boolean; onChange(value: Tier): void }) {
  return (
    <>
      {
        <label class="tier-picker">
          <span>Tier:</span>
          <select
            aria-label="Email tier"
            disabled={props.disabled}
            value={props.tier ?? ""}
            onInput={(event) => props.onChange(Number(event.currentTarget.value) as Tier)}
          >
            {props.tier === null && <option value="">Unsorted</option>}
            <option value="1">L1</option>
            <option value="2">L2</option>
            <option value="3">L3</option>
          </select>
        </label>
      }
    </>
  );
}
function EmptyReader() {
  return <>{<section class="reader empty-reader-pane" aria-label="No message selected" />}</>;
}
function EmailFrame(props: { title: string; html: string }) {
  const frameRef = { current: null } as {
    current: HTMLIFrameElement | null;
  };
  useFrameCommands(frameRef);
  createEffect(() => {
    [];
    const cleanup = untrack(() => {
      const frame = frameRef.current;
      if (!frame) return;
      let observer: ResizeObserver | undefined;
      let animationFrame = 0;
      const resize = () => {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = window.requestAnimationFrame(() => {
          const document = frame.contentDocument;
          const root = document?.documentElement;
          if (!root) return;
          frame.style.height = "1px";
          frame.style.height = `${Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0)}px`;
        });
      };
      const observe = () => {
        observer?.disconnect();
        const document = frame.contentDocument;
        const root = document?.documentElement;
        if (!root) return;
        observer = new ResizeObserver(resize);
        observer.observe(root);
        if (document.body) observer.observe(document.body);
        resize();
      };
      frame.addEventListener("load", observe);
      if (frame.contentDocument?.readyState === "complete") observe();
      return () => {
        frame.removeEventListener("load", observe);
        observer?.disconnect();
        window.cancelAnimationFrame(animationFrame);
      };
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  return (
    <>
      {
        <iframe
          ref={(element) => {
            frameRef.current = element;
          }}
          title={props.title}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcdoc={`<!doctype html><meta name="viewport" content="width=device-width"><base target="_blank"><style>html,body{overflow:hidden!important}body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>${props.html}`}
        />
      }
    </>
  );
}
function formatAddress(value: MessageSummary["from"][number]) {
  return value.name && value.name.toLowerCase() !== value.address.toLowerCase()
    ? `${value.name} <${value.address}>`
    : value.address;
}
function formatListDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
