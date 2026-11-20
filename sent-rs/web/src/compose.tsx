import {
  type Account,
  type DraftInput,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  type MailAddress,
  type MessageDetail,
} from "@sent/shared";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { Paperclip, Trash2, X } from "lucide-solid";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { sentApi } from "./api";
import { useTriage } from "./triage";
export type ComposeSeed = Partial<DraftInput> & {
  id?: string;
  files?: File[];
  onSent?: () => void;
  onUndo?: () => void;
};
type ComposeContextValue = {
  openCompose(seed?: ComposeSeed): void;
  isOpen: boolean;
};
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
export function ComposeProvider(props: { accounts: Account[]; children: JSX.Element }) {
  const [seed, setSeed] = createSignal<ComposeSeed | null>(null);
  const context = {
    openCompose: (value: ComposeSeed = {}) => {
      setSeed(value);
    },
    get isOpen() {
      return seed() !== null;
    },
  };
  return (
    <>
      {
        <ComposeContext.Provider value={context}>
          {props.children}
          <Show when={seed()} keyed>
            {(value) => (
              <Composer accounts={props.accounts} seed={value} close={() => setSeed(null)} />
            )}
          </Show>
        </ComposeContext.Provider>
      }
    </>
  );
}
function Composer(props: { accounts: Account[]; seed: ComposeSeed; close(): void }) {
  let recipientInput: HTMLInputElement | undefined;
  onMount(() => recipientInput?.focus());
  const queryClient = useQueryClient();
  const triage = useTriage();
  const compose = useCompose();
  const [draftId, setDraftId] = createSignal(props.seed.id);
  const [accountId, setAccountId] = createSignal(
    props.seed.accountId ?? props.accounts[0]?.id ?? "",
  );
  const [to, setTo] = createSignal(formatAddresses(props.seed.to));
  const [cc, setCc] = createSignal(formatAddresses(props.seed.cc));
  const [bcc, setBcc] = createSignal(formatAddresses(props.seed.bcc));
  const [subject, setSubject] = createSignal(props.seed.subject ?? "");
  const [body, setBody] = createSignal(props.seed.body ?? "");
  const [files, setFiles] = createSignal<File[]>(props.seed.files ?? []);
  const [showCopies, setShowCopies] = createSignal(
    Boolean(props.seed.cc?.length || props.seed.bcc?.length),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const hydrated = { current: false };
  const draft = createMemo<DraftInput>(() => ({
    id: draftId(),
    accountId: accountId(),
    to: parseAddresses(to()),
    cc: parseAddresses(cc()),
    bcc: parseAddresses(bcc()),
    subject: subject(),
    body: body(),
    replyToMessageId: props.seed.replyToMessageId ?? null,
    forwardOfMessageId: props.seed.forwardOfMessageId ?? null,
  }));
  const save = createMutation(() => ({
    mutationFn: (value: DraftInput) => sentApi.saveDraft(value),
    onSuccess: (saved) => {
      setDraftId(saved.id);
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (cause: Error) => setError(cause.message),
  }));
  createEffect(() => {
    [accountId(), to(), subject(), body(), draftId(), draft(), save.mutate, sending()];
    const cleanup = untrack(() => {
      if (!accountId() || sending()) return;
      if (!hydrated.current) {
        hydrated.current = true;
        if (!to() && !subject() && !body() && !draftId()) return;
      }
      const timer = window.setTimeout(() => save.mutate(draft()), 750);
      return () => window.clearTimeout(timer);
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  const send = async () => {
    if (sending()) return;
    setError(null);
    if (!accountId() || parseAddresses(to()).length === 0) {
      setError("Choose an account and add at least one recipient.");
      return;
    }
    if (files().length > MAX_ATTACHMENT_COUNT) {
      setError(`Attach at most ${MAX_ATTACHMENT_COUNT} files.`);
      return;
    }
    if (files().reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
      setError("Attachments exceed the 20 MB Sent limit.");
      return;
    }
    setSending(true);
    try {
      const saved = await sentApi.saveDraft(draft());
      const receipt = await sentApi.sendDraft(saved.id, files());
      triage.sent(receipt, () => {
        props.seed.onUndo?.();
        compose.openCompose({
          ...draft(),
          id: saved.id,
          files: files(),
          onSent: props.seed.onSent,
          onUndo: props.seed.onUndo,
        });
      });
      props.seed.onSent?.();
      await queryClient.invalidateQueries({ queryKey: ["drafts"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["thread"] });
      props.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  const discard = async () => {
    const id = draftId();
    if (id) await sentApi.deleteDraft(id);
    await queryClient.invalidateQueries({ queryKey: ["drafts"] });
    props.close();
  };
  return (
    <>
      {
        <div class="composer" role="dialog" aria-label="Compose message">
          <header class="composer-header">
            <span>New message</span>
            <button class="icon-button" onClick={props.close} aria-label="Close composer">
              <X size={19} />
            </button>
          </header>
          <div class="compose-row">
            <label for="compose-from">From</label>
            <select
              id="compose-from"
              value={accountId()}
              onInput={(event) => setAccountId(event.currentTarget.value)}
            >
              {props.accounts.map((account) => (
                <option value={account.id}>{account.email}</option>
              ))}
            </select>
          </div>
          <div class="compose-row">
            <label for="compose-to">To</label>
            <input
              id="compose-to"
              ref={recipientInput}
              value={to()}
              onInput={(event) => setTo(event.currentTarget.value)}
              placeholder="name@example.com"
              autofocus
            />
            {!showCopies() && (
              <button class="text-button" onClick={() => setShowCopies(true)}>
                Cc · Bcc
              </button>
            )}
          </div>
          {showCopies() && (
            <>
              <div class="compose-row">
                <label for="compose-cc">Cc</label>
                <input
                  id="compose-cc"
                  value={cc()}
                  onInput={(event) => setCc(event.currentTarget.value)}
                />
              </div>
              <div class="compose-row">
                <label for="compose-bcc">Bcc</label>
                <input
                  id="compose-bcc"
                  value={bcc()}
                  onInput={(event) => setBcc(event.currentTarget.value)}
                />
              </div>
            </>
          )}
          <div class="compose-row subject-row">
            <label for="compose-subject">Subject</label>
            <input
              id="compose-subject"
              value={subject()}
              onInput={(event) => setSubject(event.currentTarget.value)}
              placeholder="Subject"
            />
          </div>
          <textarea
            class="compose-body"
            value={body()}
            onInput={(event) => setBody(event.currentTarget.value)}
            placeholder="Message"
          />
          {files().length > 0 && (
            <div class="file-chips">
              {files().map((file) => (
                <span>
                  {file.name}
                  <button
                    onClick={() => setFiles((items) => items.filter((item) => item !== file))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {error() && <p class="compose-error">{error()}</p>}
          <footer class="composer-footer">
            <div class="compose-actions">
              <button class="primary-button" onClick={() => void send()} disabled={sending()}>
                {sending() ? "Sending…" : "Send"}
              </button>
              <label class="icon-button file-button" aria-label="Add attachments">
                <Paperclip size={19} />
                <input
                  type="file"
                  multiple
                  disabled={sending()}
                  onInput={(event) =>
                    setFiles([...files(), ...Array.from(event.currentTarget.files ?? [])])
                  }
                />
              </label>
              <span class="save-state">
                {save.isPending ? "Saving…" : draftId() ? "Saved" : ""}
              </span>
            </div>
            <button
              class="icon-button danger"
              disabled={sending()}
              onClick={() => void discard()}
              aria-label="Discard draft"
            >
              <Trash2 size={18} />
            </button>
          </footer>
        </div>
      }
    </>
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
