import type { Account, MessageSummary, Tier } from "@sent/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Trash2,
} from "lucide-react";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { sentApi } from "./api";
import { replySeed, useCompose } from "./compose";

const viewDetails: Record<string, { title: string; description: string }> = {
  l1: { title: "Important", description: "Mail worth your attention" },
  l2: { title: "Updates", description: "Useful automated mail" },
  l3: { title: "Low priority", description: "Everything you can safely ignore" },
  unclassified: { title: "Unclassified", description: "Visible until Sent has decided" },
  all: { title: "All mail", description: "Your complete unified archive" },
  sent: { title: "Sent", description: "Messages sent from every account" },
  trash: { title: "Trash", description: "Deleted messages" },
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
            <span className="eyebrow">Inbox</span>
            <h1>{detail?.title}</h1>
            <p>{detail?.description}</p>
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
            <span className="eyebrow">Search</span>
            <h1>{q ? `“${q}”` : "Find anything"}</h1>
            <p>
              {result.data
                ? `${result.data.messages.length} results · ${result.data.mode} search`
                : "Search across both accounts"}
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
  messages: MessageSummary[];
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
        <span className="done-mark">
          <Check size={25} />
        </span>
        <strong>You’re clear.</strong>
        <span>Nothing needs your attention here.</span>
      </div>
    );
  return (
    <div className="message-list">
      {messages.map((message) => (
        <button
          key={message.id}
          className={`message-row ${!message.read ? "unread" : ""} ${selectedId === message.id ? "selected" : ""}`}
          onClick={() => onSelect(message)}
        >
          <span className={`avatar provider-${message.account.provider}`}>
            {initials(message.from[0]?.name || message.from[0]?.address || "?")}
          </span>
          <span className="message-copy">
            <span className="message-line">
              <strong>{message.from[0]?.name || message.from[0]?.address || "Unknown"}</strong>
              <time>{formatListDate(message.receivedAt)}</time>
            </span>
            <span className="message-subject">{message.subject}</span>
            <span className="message-snippet">{message.snippet}</span>
            <span className="message-meta">
              <AccountDot provider={message.account.provider} />
              {message.account.email}
              {message.attachmentCount > 0 && (
                <>
                  <Paperclip size={12} />
                  {message.attachmentCount}
                </>
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
  const detail = useQuery({
    queryKey: ["message", messageId],
    queryFn: () => sentApi.message(messageId),
  });
  const threadId = detail.data?.threadId;
  const thread = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => sentApi.thread(threadId ?? ""),
    enabled: Boolean(threadId),
  });
  const { mutate: performAction } = useMutation({
    mutationFn: (value: string) => sentApi.action(messageId, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["message", messageId] });
    },
  });
  const tier = useMutation({
    mutationFn: (value: Tier) => sentApi.tier(messageId, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["message", messageId] });
    },
  });
  const message = detail.data;
  const conversation = (thread.data?.messages ?? []).filter((item) => item.id !== messageId);
  useEffect(() => {
    if (message && !message.read) performAction("mark_read");
  }, [message, performAction]);
  if (detail.isLoading)
    return (
      <section className="reader">
        <div className="reader-skeleton" />
      </section>
    );
  if (!message)
    return (
      <section className="reader">
        <button className="back-button" onClick={close}>
          <ArrowLeft size={18} /> Back
        </button>
        <div className="empty-reader">Message unavailable.</div>
      </section>
    );
  const account = accounts.find((item) => item.id === message.account.id);
  const doAction = (value: string, shouldClose = false) => {
    performAction(value);
    if (shouldClose) close();
  };
  return (
    <section className="reader">
      <header className="reader-toolbar">
        <button className="back-button" onClick={close}>
          <ArrowLeft size={18} />
          <span>Back</span>
        </button>
        <div className="toolbar-actions">
          <button className="icon-button" title="Archive" onClick={() => doAction("archive", true)}>
            <Archive size={18} />
          </button>
          <button className="icon-button" title="Delete" onClick={() => doAction("delete", true)}>
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
          <button className="icon-button">
            <MoreHorizontal size={19} />
          </button>
        </div>
      </header>
      <article className="message-reader">
        <div className="reader-title-row">
          <div>
            <span className="eyebrow">{message.account.email}</span>
            <h1>{message.subject}</h1>
          </div>
          <TierPicker tier={message.tier} onChange={(value) => tier.mutate(value)} />
        </div>
        {conversation.length > 0 && (
          <div className="thread-history">
            <span className="eyebrow">
              {conversation.length} other {conversation.length === 1 ? "message" : "messages"} in
              this conversation
            </span>
            {conversation.map((item) => (
              <details className="thread-message" key={item.id}>
                <summary>
                  <span className={`avatar provider-${item.account.provider}`}>
                    {initials(item.from[0]?.name || item.from[0]?.address || "?")}
                  </span>
                  <span>
                    <strong>{item.from[0]?.name || item.from[0]?.address || "Unknown"}</strong>
                    <small>{item.snippet}</small>
                  </span>
                  <time>{formatListDate(item.receivedAt)}</time>
                </summary>
                {item.htmlBody ? (
                  <iframe
                    title={`Message from ${item.from[0]?.name || item.from[0]?.address || "sender"}`}
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><base target="_blank"><style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#24221f;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#315d4b}</style>${item.htmlBody}`}
                  />
                ) : (
                  <div className="plain-body">{item.textBody}</div>
                )}
              </details>
            ))}
          </div>
        )}
        <div className="sender-block">
          <span className={`avatar large provider-${message.account.provider}`}>
            {initials(message.from[0]?.name || message.from[0]?.address || "?")}
          </span>
          <div>
            <strong>{message.from[0]?.name || message.from[0]?.address || "Unknown sender"}</strong>
            <span>{message.from[0]?.address}</span>
            <small>
              to {message.to.map((item) => item.name || item.address).join(", ") || "me"}
            </small>
          </div>
          <time>
            {new Date(message.receivedAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </div>
        <div className="email-body">
          {message.htmlBody ? (
            <iframe
              title="Email content"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><base target="_blank"><style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#24221f;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#315d4b}</style>${message.htmlBody}`}
            />
          ) : (
            <div className="plain-body">{message.textBody}</div>
          )}
        </div>
        {message.attachments.length > 0 && (
          <div className="attachments">
            <span className="eyebrow">Attachments</span>
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
        )}
        {message.reasoning && (
          <details className="reasoning">
            <summary>
              Why Sent chose L{message.tier}
              <ChevronDown size={14} />
            </summary>
            <p>{message.reasoning}</p>
          </details>
        )}
        <div className="reply-actions">
          <button onClick={() => account && compose.openCompose(replySeed(message, account))}>
            <Reply size={16} /> Reply
          </button>
          <button onClick={() => account && compose.openCompose(replySeed(message, account, true))}>
            <ReplyAll size={16} /> Reply all
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
            <CornerUpRight size={16} /> Forward
          </button>
        </div>
      </article>
    </section>
  );
}

function TierPicker({ tier, onChange }: { tier: Tier | null; onChange(value: Tier): void }) {
  return (
    <fieldset className="tier-picker" aria-label="Email tier">
      {([1, 2, 3] as Tier[]).map((value) => (
        <button
          key={value}
          className={tier === value ? "active" : ""}
          onClick={() => onChange(value)}
        >
          L{value}
        </button>
      ))}
    </fieldset>
  );
}

function EmptyReader() {
  return (
    <section className="reader empty-reader-pane">
      <div className="empty-reader">
        <span className="empty-reader-mark">
          <CornerUpLeft size={24} />
        </span>
        <strong>Open a message</strong>
        <span>Choose something from the list to read it here.</span>
      </div>
    </section>
  );
}

function AccountDot({ provider }: { provider: "gmail" | "microsoft" }) {
  return <span className={`account-dot ${provider}`} />;
}
function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
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
