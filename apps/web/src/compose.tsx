import {
  type Account,
  type DraftInput,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type MailAddress,
  type MessageDetail,
} from "@sent/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Trash2, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sentApi } from "./api";

export type ComposeSeed = Partial<DraftInput> & { id?: string };
type ComposeContextValue = { openCompose(seed?: ComposeSeed): void };
const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose(): ComposeContextValue {
  const value = useContext(ComposeContext);
  if (!value) throw new Error("Compose context is unavailable");
  return value;
}

function parseAddresses(value: string): MailAddress[] {
  return value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)\s*<([^>]+)>$/);
      return match
        ? { name: match[1]?.trim() ?? "", address: match[2]?.trim() ?? "" }
        : { name: "", address: part };
    });
}

function formatAddresses(value: MailAddress[] | undefined): string {
  return (value ?? [])
    .map((item) => (item.name ? `${item.name} <${item.address}>` : item.address))
    .join(", ");
}

export function ComposeProvider({
  accounts,
  children,
}: {
  accounts: Account[];
  children: ReactNode;
}) {
  const [seed, setSeed] = useState<ComposeSeed | null>(null);
  const context = useMemo(() => ({ openCompose: (value: ComposeSeed = {}) => setSeed(value) }), []);
  return (
    <ComposeContext.Provider value={context}>
      {children}
      {seed && (
        <Composer
          key={seed.id ?? JSON.stringify(seed)}
          accounts={accounts}
          seed={seed}
          close={() => setSeed(null)}
        />
      )}
    </ComposeContext.Provider>
  );
}

function Composer({
  accounts,
  seed,
  close,
}: {
  accounts: Account[];
  seed: ComposeSeed;
  close(): void;
}) {
  const queryClient = useQueryClient();
  const [draftId, setDraftId] = useState(seed.id);
  const [accountId, setAccountId] = useState(seed.accountId ?? accounts[0]?.id ?? "");
  const [to, setTo] = useState(formatAddresses(seed.to));
  const [cc, setCc] = useState(formatAddresses(seed.cc));
  const [bcc, setBcc] = useState(formatAddresses(seed.bcc));
  const [subject, setSubject] = useState(seed.subject ?? "");
  const [body, setBody] = useState(seed.body ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [showCopies, setShowCopies] = useState(Boolean(seed.cc?.length || seed.bcc?.length));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const hydrated = useRef(false);

  const draft = useMemo<DraftInput>(
    () => ({
      id: draftId,
      accountId,
      to: parseAddresses(to),
      cc: parseAddresses(cc),
      bcc: parseAddresses(bcc),
      subject,
      body,
      replyToMessageId: seed.replyToMessageId ?? null,
      forwardOfMessageId: seed.forwardOfMessageId ?? null,
    }),
    [draftId, accountId, to, cc, bcc, subject, body, seed],
  );

  const { mutate: saveDraft, isPending: savePending } = useMutation({
    mutationFn: (value: DraftInput) => sentApi.saveDraft(value),
    onSuccess: (saved) => {
      setDraftId(saved.id);
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  useEffect(() => {
    if (!accountId) return;
    if (!hydrated.current) {
      hydrated.current = true;
      if (!to && !subject && !body && !draftId) return;
    }
    const timer = window.setTimeout(() => saveDraft(draft), 750);
    return () => window.clearTimeout(timer);
  }, [accountId, to, subject, body, draftId, draft, saveDraft]);

  const send = async () => {
    if (sending) return;
    setError(null);
    if (!accountId || parseAddresses(to).length === 0) {
      setError("Choose an account and add at least one recipient.");
      return;
    }
    if (files.length > MAX_ATTACHMENT_COUNT) {
      setError(`Attach at most ${MAX_ATTACHMENT_COUNT} files.`);
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
      setError("Attachments exceed the 20 MB Sent limit.");
      return;
    }
    setSending(true);
    try {
      const saved = await sentApi.saveDraft(draft);
      await sentApi.sendDraft(saved.id, files);
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["thread"] });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (draftId) await sentApi.deleteDraft(draftId);
    await queryClient.invalidateQueries({ queryKey: ["drafts"] });
    close();
  };

  return (
    <div className="composer" role="dialog" aria-label="Compose message">
      <header className="composer-header">
        <span>New message</span>
        <button className="icon-button" onClick={close} aria-label="Close composer">
          <X size={19} />
        </button>
      </header>
      <div className="compose-row">
        <label htmlFor="compose-from">From</label>
        <select
          id="compose-from"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          {accounts.map((account) => (
            <option value={account.id} key={account.id}>
              {account.email}
            </option>
          ))}
        </select>
      </div>
      <div className="compose-row">
        <label htmlFor="compose-to">To</label>
        <input
          id="compose-to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="name@example.com"
          autoFocus
        />
        {!showCopies && (
          <button className="text-button" onClick={() => setShowCopies(true)}>
            Cc · Bcc
          </button>
        )}
      </div>
      {showCopies && (
        <>
          <div className="compose-row">
            <label htmlFor="compose-cc">Cc</label>
            <input id="compose-cc" value={cc} onChange={(event) => setCc(event.target.value)} />
          </div>
          <div className="compose-row">
            <label htmlFor="compose-bcc">Bcc</label>
            <input id="compose-bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} />
          </div>
        </>
      )}
      <div className="compose-row subject-row">
        <label htmlFor="compose-subject">Subject</label>
        <input
          id="compose-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Subject"
        />
      </div>
      <textarea
        className="compose-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Message"
      />
      {files.length > 0 && (
        <div className="file-chips">
          {files.map((file) => (
            <span key={`${file.name}-${file.size}`}>
              {file.name}
              <button onClick={() => setFiles((items) => items.filter((item) => item !== file))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="compose-error">{error}</p>}
      <footer className="composer-footer">
        <div className="compose-actions">
          <button className="primary-button" onClick={() => void send()} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
          <label className="icon-button file-button" aria-label="Add attachments">
            <Paperclip size={19} />
            <input
              type="file"
              multiple
              disabled={sending}
              onChange={(event) => setFiles([...files, ...Array.from(event.target.files ?? [])])}
            />
          </label>
          <span className="save-state">{savePending ? "Saving…" : draftId ? "Saved" : ""}</span>
        </div>
        <button
          className="icon-button danger"
          disabled={sending}
          onClick={() => void discard()}
          aria-label="Discard draft"
        >
          <Trash2 size={18} />
        </button>
      </footer>
    </div>
  );
}

export function replySeed(message: MessageDetail, account: Account, all = false): ComposeSeed {
  const selfAddresses = new Set([
    account.email.toLowerCase(),
    ...(message.direction === "outbound"
      ? message.from.map((item) => item.address.toLowerCase())
      : []),
  ]);
  const recipient = (message.direction === "outbound" ? message.to : message.from).filter(
    (item) => !selfAddresses.has(item.address.toLowerCase()),
  );
  const allRecipients = all
    ? [...recipient, ...message.to, ...message.cc].filter(
        (item, index, items) =>
          !selfAddresses.has(item.address.toLowerCase()) &&
          items.findIndex((other) => other.address.toLowerCase() === item.address.toLowerCase()) ===
            index,
      )
    : recipient;
  return {
    accountId: account.id,
    to: allRecipients,
    subject: message.subject.toLowerCase().startsWith("re:")
      ? message.subject
      : `Re: ${message.subject}`,
    body: `\n\nOn ${new Date(message.receivedAt).toLocaleString()}, ${message.from[0]?.name || message.from[0]?.address || "someone"} wrote:\n${message.textBody
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}`,
    replyToMessageId: message.id,
  };
}
