import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import {
  createVirtualizer,
  createWindowVirtualizer,
  measureElement,
  type Virtualizer,
} from "@tanstack/solid-virtual";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Flag,
  Forward,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  Trash2,
  X,
} from "lucide-solid";
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
import { liveInterval } from "./live";
import { MessagePreview, ReaderInsights } from "./MessageInsights";
import { optimistic, quietUntil } from "./mail-cache";
import { useMailbox } from "./mailbox";
import { cachedRow, headerData, usePrefetch } from "./prefetch";
import { ReaderMenu } from "./ReaderMenu";
import { ReaderText } from "./ReaderText";
import { localBodyPending, messageRead, replicaFor, replicaReady, threadRead } from "./replica";
import { useLocation, useNavigate, useParams, useSearchParams } from "./router";
import { useMailSearch } from "./search";
import type {
  Account,
  ConversationSummary,
  MessageDetail,
  MessageSummary,
  SearchSort,
  Tier,
} from "./shared";
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
  inbox: { title: "Inbox" },
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
  const mailbox = useMailbox(() => route.view ?? "inbox", accountId);
  const messages = mailbox.query;
  const detail = createMemo(() => viewDetails[route.view ?? "inbox"] ?? viewDetails.all);
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
                  aria-label="Filter by account"
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
              showImportance={!route.view || route.view === "inbox" || route.view === "all"}
              prefetch={prefetch}
              messages={navigation.visible}
              loading={messages.isLoading}
              hasMore={Boolean(messages.data?.nextCursor)}
              loadingMore={mailbox.loadingMore()}
              loadError={mailbox.error()}
              onLoadMore={mailbox.loadMore}
              error={messages.error?.message}
              selectedId={selectedId()}
              onSelect={select}
              emptyTitle={route.view === "trash" ? "Nothing in Trash" : "No conversations here"}
              emptyDescription={
                route.view === "trash"
                  ? "Deleted conversations will appear here."
                  : "You're up to date. New mail will appear here."
              }
            />
          </section>
          <Show when={selectedId()} keyed fallback={<EmptyReader />}>
            {(id) => (
              <Reader
                messageId={id}
                view={route.view ?? "inbox"}
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
  const sort = createMemo<SearchSort>(() =>
    params().get("sort") === "relevance" ? "relevance" : "newest",
  );
  const selectedId = createMemo(() => params().get("message"));
  const result = useMailSearch(q, sort);
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
              <select
                aria-label="Sort results"
                value={sort()}
                onInput={(event) => {
                  const next = new URLSearchParams(params());
                  if (event.currentTarget.value === "relevance") next.set("sort", "relevance");
                  else next.delete("sort");
                  setParams(next);
                }}
              >
                <option value="newest">Newest first</option>
                <option value="relevance">Most relevant</option>
              </select>
            </header>
            <MessageList
              showImportance
              prefetch={prefetch}
              messages={navigation.visible}
              loading={Boolean(q().trim()) && result.isPending}
              error={result.error?.message}
              selectedId={selectedId()}
              emptyTitle="No matching conversations"
              emptyDescription="Try a different name, phrase, or email address."
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
  showImportance?: boolean;
  prefetch?(message: ConversationSummary): void;
  messages: ConversationSummary[];
  loading: boolean;
  error?: string;
  selectedId: string | null;
  onSelect(message: MessageSummary): void;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadError?: string;
  onLoadMore?(): Promise<void>;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const [list, setList] = createSignal<HTMLDivElement>();
  const mobileQuery = window.matchMedia("(max-width: 700px)");
  const [mobile, setMobile] = createSignal(mobileQuery.matches);
  const updateMobile = () => setMobile(mobileQuery.matches);
  mobileQuery.addEventListener("change", updateMobile);
  onCleanup(() => mobileQuery.removeEventListener("change", updateMobile));
  const itemKey = createMemo(() => {
    const ids = props.messages.map((message) => message.threadId);
    return (index: number) => ids[index];
  });
  const sharedOptions = {
    get count() {
      return props.messages.length;
    },
    get getItemKey() {
      return itemKey();
    },
    estimateSize: () => 150,
    measureElement: <ScrollElement extends Element | Window>(
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<ScrollElement, HTMLDivElement>,
    ) => measureElement(element, entry, instance) || 150,
    overscan: 5,
    initialRect: { width: 400, height: 700 },
  };
  const paneVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    ...sharedOptions,
    get count() {
      return sharedOptions.count;
    },
    get getItemKey() {
      return itemKey();
    },
    getScrollElement: () => list() ?? null,
    get enabled() {
      return !mobile();
    },
  });
  // Native document scrolling lets mobile Safari collapse its browser bars.
  // Keep desktop's independently scrolling, virtualized split view unchanged.
  let listMargin = 0;
  const pageVirtualizer = createWindowVirtualizer<HTMLDivElement>({
    ...sharedOptions,
    get count() {
      return sharedOptions.count;
    },
    get getItemKey() {
      return itemKey();
    },
    get enabled() {
      return mobile();
    },
    // Disabling clears measured row heights. Keep them while the reader hides
    // the list, and don't replace them with zero-size hidden DOM measurements.
    get useCachedMeasurements() {
      return Boolean(props.selectedId);
    },
    get scrollMargin() {
      if (!props.selectedId)
        listMargin = list() ? (list()?.getBoundingClientRect().top ?? 0) + window.scrollY : 0;
      return listMargin;
    },
  });
  const virtualizer = () => (mobile() ? pageVirtualizer : paneVirtualizer);
  let listScroll = 0;
  const rememberScroll = () => {
    if (mobile() && !props.selectedId) listScroll = window.scrollY;
  };
  window.addEventListener("scroll", rememberScroll, { passive: true });
  onCleanup(() => window.removeEventListener("scroll", rememberScroll));
  createEffect(() => {
    const selected = props.selectedId;
    if (mobile()) queueMicrotask(() => window.scrollTo(0, selected ? 0 : listScroll));
  });
  const positions = createMemo(
    () => new Map(props.messages.map((message, index) => [message.threadId, index])),
  );
  const slots = createMemo(
    () =>
      new Map(
        virtualizer()
          .getVirtualItems()
          .map((row) => [row.key, row]),
      ),
  );
  const rendered = createMemo(() =>
    virtualizer()
      .getVirtualItems()
      .flatMap((row) => (props.messages[row.index] ? [props.messages[row.index]] : [])),
  );
  const [pendingFocus, setPendingFocus] = createSignal<string | null>(null);
  const [pendingNext, setPendingNext] = createSignal<string | null>(null);
  const [cursorThreadId, setCursorThreadId] = createSignal<string | null>(null);
  const currentIndex = createMemo(() =>
    messageCursorIndex(props.messages, props.selectedId, cursorThreadId()),
  );
  const focusIndex = (index: number) => {
    const message = props.messages[index];
    if (!message) return;
    setCursorThreadId(message.threadId);
    setPendingFocus(message.threadId);
    virtualizer().scrollToIndex(index, { align: "auto" });
    if (props.selectedId && props.selectedId !== message.id) props.onSelect(message);
  };
  const move = (direction: number) => {
    setPendingNext(null);
    if (direction > 0 && currentIndex() === props.messages.length - 1 && props.hasMore) {
      setPendingNext(props.messages.at(-1)?.threadId ?? null);
      void props.onLoadMore?.();
      return;
    }
    focusIndex(nextMessageIndex(props.messages.length, currentIndex(), direction));
  };
  createEffect(() => {
    const id = pendingNext();
    if (!id) return;
    const index = positions().get(id);
    if (index === undefined || currentIndex() !== index || props.loadError) setPendingNext(null);
    else if (props.messages[index + 1]) {
      setPendingNext(null);
      untrack(() => focusIndex(index + 1));
    } else if (!props.hasMore) setPendingNext(null);
  });
  const selectedThread = createMemo(
    () => props.messages.find((message) => message.id === props.selectedId)?.threadId,
  );
  createEffect(() => {
    const element = list();
    const id = selectedThread();
    if (element && id)
      queueMicrotask(() => {
        if (list() === element && selectedThread() === id)
          if (!mobile()) virtualizer().scrollToIndex(positions().get(id) ?? 0, { align: "auto" });
      });
  });
  createEffect(() => {
    const id = pendingFocus();
    rendered();
    if (!id) return;
    queueMicrotask(() => {
      if (pendingFocus() !== id) return;
      const button = Array.from(
        list()?.querySelectorAll<HTMLButtonElement>(".message-row") ?? [],
      ).find((row) => row.dataset.threadId === id);
      if (button) {
        button.focus({ preventScroll: true });
        setPendingFocus(null);
      }
    });
  });
  createEffect(() => {
    const last = virtualizer().getVirtualItems().at(-1)?.index ?? -1;
    if (
      props.hasMore &&
      !props.loadingMore &&
      !props.loadError &&
      last >= props.messages.length - 8
    )
      void props.onLoadMore?.();
  });
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
            <MailOpen size={26} stroke-width={1.5} aria-hidden="true" />
            <strong>{props.emptyTitle ?? "No conversations here"}</strong>
            {props.emptyDescription && <span>{props.emptyDescription}</span>}
          </div>
        }
      </Match>
      <Match when={true}>
        {
          <div
            class={`message-list ${props.showImportance ? "importance-tint" : ""}`}
            ref={(element) =>
              queueMicrotask(() => {
                if (element.isConnected) setList(element);
              })
            }
          >
            <div
              style={{
                height: `${virtualizer().getTotalSize()}px`,
                position: "relative",
                width: "100%",
              }}
            >
              <For each={rendered()}>
                {(message) => (
                  <div
                    data-index={positions().get(message.threadId)}
                    ref={(element) => {
                      element.dataset.index = String(positions().get(message.threadId));
                      virtualizer().measureElement(element);
                    }}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      width: "100%",
                      transform: `translateY(${(slots().get(message.threadId)?.start ?? 0) - (mobile() ? (pageVirtualizer.options.scrollMargin ?? 0) : 0)}px)`,
                    }}
                    class={`message-list-item ${props.selectedId === message.id ? "selected" : ""}`}
                  >
                    <button
                      data-index={positions().get(message.threadId)}
                      data-thread-id={message.threadId}
                      aria-current={props.selectedId === message.id ? "true" : undefined}
                      onFocus={() => {
                        setCursorThreadId(message.threadId);
                        props.prefetch?.(message);
                      }}
                      onMouseEnter={() => props.prefetch?.(message)}
                      class={`message-row ${message.tier ? `tier-${message.tier}` : ""} ${!message.read ? "unread" : ""} ${message.tier === null && message.direction === "inbound" ? "unclassified" : ""} ${props.selectedId === message.id ? "selected" : ""}`}
                      onClick={() => props.onSelect(message)}
                    >
                      <span class="message-copy">
                        <span class="message-line">
                          <span class="conversation-senders">
                            <strong>
                              {message.participants
                                .map((person) =>
                                  person.address.toLowerCase() ===
                                  message.account.email.toLowerCase()
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
                          <span class="message-time">
                            {message.attachmentCount > 0 && (
                              <Paperclip size={13} aria-label="Has attachment" />
                            )}
                            {message.flagged && (
                              <Flag size={12} fill="currentColor" aria-label="Flagged" />
                            )}
                            <time>{formatListDate(message.receivedAt)}</time>
                            {message.tier === null && message.direction === "inbound" && (
                              <span class="visually-hidden">Sorting…</span>
                            )}
                            {message.syncPending && <span>Syncing…</span>}
                          </span>
                        </span>
                        <span class="message-subject">
                          {message.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") ||
                            "(No subject)"}
                        </span>
                        <MessagePreview message={message} />
                      </span>
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={props.loadingMore}>
              <div class="message-pagination" role="status">
                Loading more…
              </div>
            </Show>
            <Show when={props.loadError}>
              <div class="message-pagination" role="status">
                {props.loadError}
                <button onClick={() => void props.onLoadMore?.()}>Retry loading more</button>
              </div>
            </Show>
          </div>
        }
      </Match>
    </Switch>
  );
}
function Reader(props: {
  messageId: string;
  view?: string;
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
  const [summaryOpen, setSummaryOpen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [hasShownFallback, setHasShownFallback] = createSignal(false);
  const openedMessages = { current: new Set<string>() };
  const detail = createQuery<MessageDetail>(() => ({
    queryKey: ["message", props.messageId],
    networkMode: "always",
    refetchOnReconnect: (query) => (localBodyPending(query.state.data) ? "always" : true),
    queryFn: ({ signal }) => messageRead(queryClient, props.messageId, signal),
    placeholderData: headerData(props.summary ?? cachedRow(queryClient, props.messageId)),
  }));
  const threadId = createMemo(() => props.summary?.threadId ?? detail.data?.threadId);
  const thread = createQuery<{ messages: MessageDetail[] }>(() => ({
    queryKey: ["thread", threadId(), trash()],
    networkMode: "always",
    refetchOnReconnect: (query) =>
      query.state.data?.messages.some(localBodyPending) ? "always" : true,
    queryFn: ({ signal }) => threadRead(queryClient, threadId() ?? "", trash(), signal),
    enabled: Boolean(threadId()),
    refetchInterval:
      replicaReady(queryClient) || quietUntil(queryClient) > Date.now()
        ? false
        : liveInterval(queryClient),
  }));
  const orderedMessages = createMemo(
    () => thread.data?.messages ?? (detail.data ? [detail.data] : []),
  );
  createEffect(() => {
    if (replicaReady(queryClient))
      replicaFor(queryClient)?.opened(orderedMessages().map((message) => message.id));
  });
  const readerLoading = createMemo(
    () =>
      !thread.data &&
      !detail.data &&
      !hasShownFallback() &&
      (detail.isPending || (Boolean(threadId()) && thread.isPending)),
  );
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
        props.view ?? route.view ?? "all",
        params().get("account") ?? undefined,
      );
  };
  const reply = (all = false) => {
    const item = message();
    const owner = account();
    if (item && owner && !localBodyPending(item))
      compose.openCompose({
        ...replySeed(item, owner, all),
        onSent: props.advance,
        onUndo: props.restore,
      });
  };
  const forward = () => {
    const item = message();
    if (!item || localBodyPending(item)) return;
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
    () =>
      !message() ||
      headerOnly() ||
      action.isPending ||
      tier.isPending ||
      (!thread.data && !thread.isError),
  );
  const cannotQuote = createMemo(() => unavailable() || localBodyPending(message()));
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
      disabled: cannotQuote() || !account(),
    },
    {
      id: "reply-all",
      label: "Reply all",
      group: "Message",
      keys: ["a"],
      run: () => reply(true),
      disabled: cannotQuote() || !account(),
    },
    {
      id: "forward",
      label: "Forward message",
      group: "Message",
      keys: ["f"],
      run: forward,
      disabled: cannotQuote(),
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
  const hasPlainText = createMemo(() =>
    [message(), ...conversation()].some((item) => Boolean(item?.plainText?.trim())),
  );
  return (
    <Switch>
      <Match when={readerLoading()}>
        {
          <section class="reader">
            <header class="reader-toolbar">
              <button
                class="icon-button back-button"
                aria-label="Back to mail"
                title="Back to mail"
                onClick={props.close}
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
            </header>
            <div class="message-reader">
              <div class="reader-skeleton" />
            </div>
          </section>
        }
      </Match>
      <Match when={!message()}>
        {
          <section class="reader">
            <header class="reader-toolbar">
              <button
                class="icon-button back-button"
                aria-label="Back to mail"
                title="Back to mail"
                onClick={props.close}
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
            </header>
            <div class="empty-list">Message unavailable.</div>
          </section>
        }
      </Match>
      <Match when={message()}>
        {(current) => (
          <section class="reader">
            <header class="reader-toolbar">
              <button
                class="icon-button back-button"
                aria-label="Back to mail"
                title="Back to mail"
                onClick={props.close}
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <div class="toolbar-actions">
                <button
                  class="icon-button"
                  title="Archive conversation"
                  disabled={unavailable()}
                  aria-label="Archive conversation"
                  onClick={() => triageAction("archive")}
                >
                  <Archive size={18} />
                </button>
                <button
                  class="icon-button"
                  title="Delete conversation"
                  disabled={unavailable()}
                  aria-label="Delete conversation"
                  onClick={() => triageAction("delete")}
                >
                  <Trash2 size={18} />
                </button>
                <button
                  class="icon-button"
                  title={current().read ? "Mark unread" : "Mark read"}
                  aria-label={current().read ? "Mark unread" : "Mark read"}
                  disabled={unavailable()}
                  onClick={() => doAction(current().read ? "mark_unread" : "mark_read")}
                >
                  {current().read ? <Mail size={18} /> : <MailOpen size={18} />}
                </button>
                <button
                  class={`icon-button ${current().flagged ? "active" : ""}`}
                  title={current().flagged ? "Unflag" : "Flag"}
                  aria-label={current().flagged ? "Unflag" : "Flag"}
                  aria-pressed={current().flagged}
                  disabled={unavailable()}
                  onClick={() => doAction(current().flagged ? "unflag" : "flag")}
                >
                  <Flag size={18} fill={current().flagged ? "currentColor" : "none"} />
                </button>
                <ReaderMenu
                  disabled={unavailable()}
                  tier={current().tier}
                  onTier={(value) => tier.mutate({ id: current().id, tier: value })}
                  hasInsights={Boolean(
                    current().aiSummary?.trim() ||
                      (current().reasoning?.trim() && current().modelTier !== null),
                  )}
                  summaryOpen={summaryOpen()}
                  onSummary={() => setSummaryOpen((open) => !open)}
                  hasPlainText={hasPlainText()}
                  bodyView={bodyView()}
                  onBodyView={() =>
                    setBodyView((view) => (view === "plain" ? "original" : "plain"))
                  }
                  onDetails={() => setDetailsOpen(true)}
                />
              </div>
            </header>
            {action.error && (
              <p class="compose-error" role="alert">
                {action.error.message}
              </p>
            )}
            {tier.error && (
              <p class="compose-error" role="alert">
                Couldn't move the message. {tier.error.message}
              </p>
            )}
            <article class="message-reader">
              <div class="reading-column">
                <header class="conversation-heading">
                  <h2>
                    {current().subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") || "(No subject)"}
                  </h2>
                </header>
                {thread.isError && (
                  <p role="status">
                    {thread.data
                      ? "Couldn’t refresh the conversation. Showing saved messages."
                      : "Couldn’t load the conversation. Showing the selected message."}
                  </p>
                )}
                {conversation().length > 0 && (
                  <details class="thread-history">
                    <summary>
                      {conversation().length} earlier{" "}
                      {conversation().length === 1 ? "message" : "messages"}
                      <ChevronDown size={13} aria-hidden="true" />
                    </summary>
                    <div class="thread-history-messages">
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
                  </details>
                )}
                <section class="latest-message" aria-label="Latest message">
                  <div class="latest-message-heading">
                    <details
                      class="message-details"
                      open={detailsOpen()}
                      onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
                    >
                      <summary aria-label="Message details">
                        <span class="sender-avatar" aria-hidden="true">
                          {senderInitials(current())}
                        </span>
                        <span class="sender-identity">
                          <strong title={current().from[0]?.address}>
                            {current().from[0]?.name ||
                              current().from[0]?.address ||
                              "Unknown sender"}
                          </strong>
                          <span>
                            {recipientLabel(current())}
                            <ChevronDown size={11} aria-hidden="true" />
                          </span>
                        </span>
                      </summary>
                      <dl>
                        <div>
                          <dt>From</dt>
                          <dd>
                            {current().from.map(formatAddress).join(", ") || "Unknown sender"}
                          </dd>
                        </div>
                        <div>
                          <dt>To</dt>
                          <dd>
                            {current().to.map(formatAddress).join(", ") || "Undisclosed recipients"}
                          </dd>
                        </div>
                        <Show when={current().cc.length}>
                          <div>
                            <dt>Cc</dt>
                            <dd>{current().cc.map(formatAddress).join(", ")}</dd>
                          </div>
                        </Show>
                        <Show when={current().bcc.length}>
                          <div>
                            <dt>Bcc</dt>
                            <dd>{current().bcc.map(formatAddress).join(", ")}</dd>
                          </div>
                        </Show>
                        <div>
                          <dt>Account</dt>
                          <dd>{current().account.email}</dd>
                        </div>
                        <div>
                          <dt>Date</dt>
                          <dd>{new Date(current().receivedAt).toLocaleString()}</dd>
                        </div>
                      </dl>
                    </details>
                    <time
                      dateTime={current().receivedAt}
                      title={new Date(current().receivedAt).toLocaleString()}
                    >
                      {formatReaderDate(current().receivedAt)}
                    </time>
                  </div>
                  <Show when={summaryOpen()}>
                    <div class="reader-summary">
                      <button
                        class="icon-button"
                        title="Close summary"
                        aria-label="Close summary"
                        onClick={() => setSummaryOpen(false)}
                      >
                        <X size={14} />
                      </button>
                      <ReaderInsights message={current()} />
                    </div>
                  </Show>
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
                  <button disabled={cannotQuote()} onClick={() => reply()}>
                    <Reply size={17} aria-hidden="true" />
                    Reply
                  </button>
                  <button
                    class="icon-button"
                    title="Reply all"
                    aria-label="Reply all"
                    disabled={cannotQuote()}
                    onClick={() => reply(true)}
                  >
                    <ReplyAll size={18} aria-hidden="true" />
                  </button>
                  <button
                    class="icon-button"
                    title="Forward"
                    aria-label="Forward"
                    disabled={cannotQuote()}
                    onClick={forward}
                  >
                    <Forward size={18} aria-hidden="true" />
                  </button>
                </div>
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
        if (localBodyPending(props.message))
          return (
            <div class="plain-body" role="status">
              Loading message…
            </div>
          );
        if (props.view === "plain" && props.message.plainText?.trim())
          return <ReaderText text={props.message.plainText} />;
        if (props.message.htmlBody)
          return <EmailFrame title={props.title} html={props.message.htmlBody} />;
        return <div class="plain-body">{props.message.textBody}</div>;
      })()}
    </>
  );
}
function EmptyReader() {
  return (
    <section class="reader empty-reader-pane" aria-label="No message selected">
      <MailOpen size={34} stroke-width={1.25} aria-hidden="true" />
      <strong>A little room to focus.</strong>
      <p>Choose a conversation to read it here.</p>
      <p class="reader-hint">
        <kbd>j</kbd> <kbd>k</kbd> to move · <kbd>Enter</kbd> to open
      </p>
    </section>
  );
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
function senderInitials(message: MessageSummary) {
  const sender = message.from[0];
  const name = sender?.name.trim();
  if (!name) return sender?.address.slice(0, 2).toUpperCase() || "?";
  const words = name.split(/\s+/);
  return (words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "");
}
function recipientLabel(message: MessageDetail) {
  const first = message.to[0];
  if (!first) return "to undisclosed recipients";
  const name =
    first.address.toLowerCase() === message.account.email.toLowerCase()
      ? "me"
      : first.name || first.address;
  return `to ${name}${message.to.length > 1 ? ` and ${message.to.length - 1} more` : ""}`;
}
function formatReaderDate(value: string) {
  const date = new Date(value);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const day =
    date.toDateString() === now.toDateString()
      ? "Today"
      : date.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
        });
  return `${day}, ${time}`;
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
