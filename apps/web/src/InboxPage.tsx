import type {
  Account,
  ConversationSummary,
  MessageDetail,
  MessageSummary,
  Tier,
} from "@sent/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Flag, Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { sentApi } from "./api";
import { replySeed, useCompose } from "./compose";
import { ReaderText } from "./ReaderText";

const viewDetails: Record<string, { title: string }> = {
  l1: { title: "Important" },
  l2: { title: "Updates" },
  l3: { title: "Low priority" },
  unclassified: { title: "Sorting" },
  all: { title: "All mail" },
  sent: { title: "Sent" },
  trash: { title: "Trash" },
};

export function InboxPage({ accounts }: { accounts: Account[] }) {
  const { view = "l1" } = useParams();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("message");
  const accountId = params.get("account") ?? undefined;
  const query = new URLSearchParams({ view, limit: "75" });
  if (accountId) query.set("accountId", accountId);
  const messages = useQuery({
    queryKey: ["messages", view, accountId],
    queryFn: () => sentApi.messages(query),
    refetchInterval: 4_000,
  });
  const detail = viewDetails[view] ?? viewDetails.all;
  const select = (message: MessageSummary) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("message", message.id);
      return next;
    });
  };
  return (
    <div className={`mail-layout ${selectedId ? "has-reader" : ""}`}>
      <section className="message-pane">
        <header className="pane-heading">
          <div>
            <h1>{detail?.title}</h1>
          </div>
          {accounts.length > 1 && (
            <select
              value={accountId ?? ""}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value) next.set("account", event.target.value);
                else next.delete("account");
                next.delete("message");
                setParams(next);
              }}
            >
              <option value="">All accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          )}
        </header>
        <MessageList
          messages={messages.data?.messages ?? []}
          loading={messages.isLoading}
          error={messages.error?.message}
          selectedId={selectedId}
          onSelect={select}
        />
      </section>
      {selectedId ? (
        <Reader
          key={selectedId}
          messageId={selectedId}
          accounts={accounts}
          close={() => {
            const next = new URLSearchParams(params);
            next.delete("message");
            setParams(next);
          }}
        />
      ) : (
        <EmptyReader />
      )}
    </div>
  );
}

export function SearchResults({ accounts }: { accounts: Account[] }) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const selectedId = params.get("message");
  const result = useQuery({
    queryKey: ["search", q],
    queryFn: () => sentApi.search(new URLSearchParams({ q, limit: "75" })),
    enabled: Boolean(q),
  });
  return (
    <div className={`mail-layout ${selectedId ? "has-reader" : ""}`}>
      <section className="message-pane">
        <header className="pane-heading">
          <div>
            <h1>Search</h1>
            <p>
              {result.data
                ? `${q} · ${result.data.messages.length} ${result.data.messages.length === 1 ? "conversation" : "conversations"}`
                : q}
            </p>
          </div>
        </header>
        <MessageList
          messages={result.data?.messages ?? []}
          loading={result.isLoading}
          error={result.error?.message}
          selectedId={selectedId}
          onSelect={(message) => {
            const next = new URLSearchParams(params);
            next.set("message", message.id);
            setParams(next);
          }}
        />
      </section>
      {selectedId ? (
        <Reader
          key={selectedId}
          messageId={selectedId}
          accounts={accounts}
          close={() => {
            const next = new URLSearchParams(params);
            next.delete("message");
            setParams(next);
          }}
        />
      ) : (
        <EmptyReader />
      )}
    </div>
  );
}

function MessageList({
  messages,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  messages: ConversationSummary[];
  loading: boolean;
  error?: string;
  selectedId: string | null;
  onSelect(message: MessageSummary): void;
}) {
  if (loading)
    return (
      <div className="message-loading">
        {["one", "two", "three", "four", "five", "six", "seven", "eight"].map((key) => (
          <div className="skeleton-row" key={key} />
        ))}
      </div>
    );
  if (error)
    return (
      <div className="empty-list">
        <strong>Couldn’t load mail</strong>
        <span>{error}</span>
      </div>
    );
  if (messages.length === 0)
    return (
      <div className="empty-list">
        <strong>No messages</strong>
      </div>
    );
  return (
    <div className="message-list">
      {messages.map((message) => (
        <button
          key={message.threadId}
          className={`message-row ${!message.read ? "unread" : ""} ${message.tier === null && message.direction === "inbound" ? "unclassified" : ""} ${selectedId === message.id ? "selected" : ""}`}
          onClick={() => onSelect(message)}
        >
          <span className="message-copy">
            <span className="message-line">
              <span className="conversation-senders">
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
                  <span className="conversation-count" title={`${message.messageCount} messages`}>
                    {message.messageCount}
                    <span className="visually-hidden"> messages</span>
                  </span>
                )}
              </span>
              <time>{formatListDate(message.receivedAt)}</time>
            </span>
            <span className="message-subject">
              {message.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") || "(No subject)"}
            </span>
            <span className="message-snippet">{message.snippet}</span>
            <span className="message-meta">
              {message.account.email}
              {message.unreadCount > 0 && (
                <span className="conversation-unread">{message.unreadCount} unread</span>
              )}
              {message.attachmentCount > 0 && (
                <>
                  <Paperclip size={12} />
                  {message.attachmentCount}
                </>
              )}
              {message.tier === null && message.direction === "inbound" && (
                <span className="sorting-label">Sorting…</span>
              )}
              {message.syncPending && <span>Syncing…</span>}
            </span>
          </span>
          {message.flagged && <Flag className="row-flag" size={14} fill="currentColor" />}
        </button>
      ))}
    </div>
  );
}

function Reader({
  messageId,
  accounts,
  close,
}: {
  messageId: string;
  accounts: Account[];
  close(): void;
}) {
  const queryClient = useQueryClient();
  const compose = useCompose();
  const { view } = useParams();
  const trash = view === "trash";
  const [bodyView, setBodyView] = useState<"plain" | "original">("plain");
  const [hasShownFallback, setHasShownFallback] = useState(false);
  const newestRef = useRef<HTMLElement>(null);
  const openedMessages = useRef(new Set<string>());
  const scrolledToNewest = useRef(false);
  const detail = useQuery({
    queryKey: ["message", messageId],
    queryFn: () => sentApi.message(messageId),
  });
  const threadId = detail.data?.threadId;
  const thread = useQuery({
    queryKey: ["thread", threadId, trash],
    queryFn: () => sentApi.thread(threadId ?? "", trash),
    enabled: Boolean(threadId),
    refetchInterval: 4_000,
  });
  const orderedMessages = thread.data?.messages ?? (detail.data ? [detail.data] : []);
  const message = orderedMessages.at(-1);
  const conversation = orderedMessages.slice(0, -1);
  const { mutate: performAction } = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => sentApi.action(id, action),
    onSuccess: (_result, { id, action }) => {
      const updateMessage = (item: MessageDetail): MessageDetail => {
        if (item.id !== id) return item;
        if (action === "mark_read" || action === "mark_unread")
          return { ...item, read: action === "mark_read" };
        if (action === "flag" || action === "unflag")
          return { ...item, flagged: action === "flag" };
        return item;
      };
      // A successful write must remain visible even when refreshing the thread
      // fails. Otherwise cached toolbar controls keep acting on stale state.
      queryClient.setQueriesData<{ messages: MessageDetail[] }>(
        { queryKey: ["thread", threadId] },
        (cached) => (cached ? { ...cached, messages: cached.messages.map(updateMessage) } : cached),
      );
      queryClient.setQueryData<MessageDetail>(["message", id], (cached) =>
        cached ? updateMessage(cached) : cached,
      );
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["message"] });
      void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    },
  });
  const tier = useMutation({
    mutationFn: (value: Tier) => sentApi.tier(message?.id ?? messageId, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["message", messageId] });
      void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
    },
  });
  useEffect(() => {
    if (thread.isError) setHasShownFallback(true);
    // On a thread failure the selected message is still shown. Mark only what
    // was displayed, then handle any remaining messages if the thread recovers.
    const visible = thread.data?.messages ?? (thread.isError && detail.data ? [detail.data] : []);
    for (const item of visible) {
      if (openedMessages.current.has(item.id)) continue;
      openedMessages.current.add(item.id);
      if (!item.read) performAction({ id: item.id, action: "mark_read" });
    }
  }, [thread.data, thread.isError, detail.data, performAction]);
  useEffect(() => {
    if (!thread.data || scrolledToNewest.current || !newestRef.current) return;
    scrolledToNewest.current = true;
    newestRef.current.scrollIntoView({ block: "nearest" });
  }, [thread.data]);
  if (detail.isLoading || (thread.isLoading && !hasShownFallback))
    return (
      <section className="reader">
        <div className="reader-skeleton" />
      </section>
    );
  if (!message)
    return (
      <section className="reader">
        <button className="back-button" onClick={close}>
          Back
        </button>
        <div className="empty-list">Message unavailable.</div>
      </section>
    );
  const account = accounts.find((item) => item.id === message.account.id);
  const hasPlainText = [message, ...conversation].some((item) => Boolean(item.plainText?.trim()));
  const doAction = (value: string, shouldClose = false) => {
    performAction({ id: message.id, action: value });
    if (shouldClose) close();
  };
  return (
    <section className="reader">
      <header className="reader-toolbar">
        <button className="back-button" onClick={close}>
          <span>Back</span>
        </button>
        <div className="toolbar-actions">
          <TierPicker tier={message.tier} onChange={(value) => tier.mutate(value)} />
          <button
            className="icon-button"
            title="Archive latest message"
            onClick={() => doAction("archive", true)}
          >
            <Archive size={18} />
          </button>
          <button
            className="icon-button"
            title="Delete latest message"
            onClick={() => doAction("delete", true)}
          >
            <Trash2 size={18} />
          </button>
          <button
            className="icon-button"
            title={message.read ? "Mark unread" : "Mark read"}
            onClick={() => doAction(message.read ? "mark_unread" : "mark_read")}
          >
            {message.read ? <Mail size={18} /> : <MailOpen size={18} />}
          </button>
          <button
            className={`icon-button ${message.flagged ? "active" : ""}`}
            title="Flag"
            onClick={() => doAction(message.flagged ? "unflag" : "flag")}
          >
            <Flag size={18} fill={message.flagged ? "currentColor" : "none"} />
          </button>
        </div>
      </header>
      <article className="message-reader">
        <header className="conversation-heading">
          <h2>{message.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "") || "(No subject)"}</h2>
          <p>
            {orderedMessages.length} {orderedMessages.length === 1 ? "message" : "messages"} ·{" "}
            {message.account.email}
          </p>
        </header>
        {thread.isError && (
          <p role="status">
            {thread.data
              ? "Couldn’t refresh the conversation. Showing saved messages."
              : "Couldn’t load the conversation. Showing the selected message."}
          </p>
        )}
        {hasPlainText && (
          <nav className="body-view-picker" aria-label="Message body view">
            <button
              className={bodyView === "plain" ? "active" : ""}
              onClick={() => setBodyView("plain")}
            >
              Plain text
            </button>
            <button
              className={bodyView === "original" ? "active" : ""}
              onClick={() => setBodyView("original")}
            >
              Original
            </button>
          </nav>
        )}
        {conversation.length > 0 && (
          <div className="thread-history">
            <span className="section-label">Earlier in this conversation</span>
            {conversation.map((item) => (
              <details className="thread-message" key={item.id}>
                <summary>
                  <span>
                    <strong>{item.from[0]?.name || item.from[0]?.address || "Unknown"}</strong>
                    <small>{item.snippet}</small>
                  </span>
                  <time>{formatListDate(item.receivedAt)}</time>
                </summary>
                <MessageBody
                  message={item}
                  view={bodyView}
                  title={`Message from ${item.from[0]?.name || item.from[0]?.address || "sender"}`}
                />
                <MessageAttachments message={item} />
              </details>
            ))}
          </div>
        )}
        <section className="latest-message" ref={newestRef} aria-label="Latest message">
          <div className="latest-message-heading">
            <strong>{message.from[0] ? formatAddress(message.from[0]) : "Unknown sender"}</strong>
            <time dateTime={message.receivedAt}>
              {new Date(message.receivedAt).toLocaleString()}
            </time>
          </div>
          <p className="latest-recipients">
            To: {message.to.map(formatAddress).join(", ") || "me"}
          </p>
          {conversation.length > 0 && <span className="latest-label">Latest message</span>}
          <div className="email-body">
            <MessageBody message={message} view={bodyView} title="Email content" />
          </div>
          <MessageAttachments message={message} />
          {message.reasoning && (
            <details className="reasoning">
              <summary>Why Sent chose L{message.tier}</summary>
              <p>{message.reasoning}</p>
            </details>
          )}
        </section>
        <div className="reply-actions">
          <button onClick={() => account && compose.openCompose(replySeed(message, account))}>
            Reply
          </button>
          <button onClick={() => account && compose.openCompose(replySeed(message, account, true))}>
            Reply all
          </button>
          <button
            onClick={() =>
              compose.openCompose({
                accountId: message.account.id,
                subject: message.subject.toLowerCase().startsWith("fwd:")
                  ? message.subject
                  : `Fwd: ${message.subject}`,
                body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from[0]?.name || message.from[0]?.address}\nDate: ${new Date(message.receivedAt).toLocaleString()}\nSubject: ${message.subject}\n\n${message.textBody}`,
                forwardOfMessageId: message.id,
              })
            }
          >
            Forward
          </button>
        </div>
      </article>
    </section>
  );
}

export function MessageAttachments({
  message,
}: {
  message: Pick<MessageDetail, "id" | "attachments">;
}) {
  if (message.attachments.length === 0) return null;
  return (
    <div className="attachments">
      <span className="section-label">Attachments</span>
      <div>
        {message.attachments.map((item) => (
          <a
            key={item.id}
            href={`/api/messages/${message.id}/attachments/${encodeURIComponent(item.id)}`}
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
}

function MessageBody({
  message,
  view,
  title,
}: {
  message: MessageDetail;
  view: "plain" | "original";
  title: string;
}) {
  if (view === "plain" && message.plainText?.trim()) return <ReaderText text={message.plainText} />;
  if (message.htmlBody) return <EmailFrame title={title} html={message.htmlBody} />;
  return <div className="plain-body">{message.textBody}</div>;
}

function TierPicker({ tier, onChange }: { tier: Tier | null; onChange(value: Tier): void }) {
  return (
    <label className="tier-picker">
      <span>Tier:</span>
      <select
        aria-label="Email tier"
        value={tier ?? ""}
        onChange={(event) => onChange(Number(event.target.value) as Tier)}
      >
        {tier === null && <option value="">Unsorted</option>}
        <option value="1">L1</option>
        <option value="2">L2</option>
        <option value="3">L3</option>
      </select>
    </label>
  );
}

function EmptyReader() {
  return <section className="reader empty-reader-pane" aria-label="No message selected" />;
}

function EmailFrame({ title, html }: { title: string; html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
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
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><base target="_blank"><style>html,body{overflow:hidden!important}body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>${html}`}
    />
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
