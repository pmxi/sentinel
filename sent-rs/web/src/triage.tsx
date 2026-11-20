import type { MutationReceipt } from "@sent/shared";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { Archive, Check, Trash2, X } from "lucide-solid";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import { sentApi } from "./api";
import { optimistic } from "./mail-cache";

type Notice = {
  id: string;
  label: string;
  threadId?: string;
  action?: "archive" | "delete";
  receipt?: MutationReceipt;
  onUndo?: () => void;
  error?: boolean;
  transaction?: ReturnType<typeof optimistic>;
};
type TriageContextValue = {
  hiddenThreadIds: Set<string>;
  perform(
    threadId: string,
    action: "archive" | "delete",
    advance: () => void,
    restore: () => void,
    view: string,
    accountId?: string,
  ): void;
  sent(receipt: MutationReceipt, onUndo: () => void): void;
};
const TriageContext = createContext<TriageContextValue | null>(null);
export function useTriage() {
  const value = useContext(TriageContext);
  if (!value) throw new Error("Triage context is unavailable");
  return value;
}
export function TriageProvider(props: { children: JSX.Element }) {
  const client = useQueryClient();
  const [notices, setNotices] = createSignal<Notice[]>([]);
  const refresh = async () => {
    await Promise.all(
      ["messages", "search", "message", "thread", "drafts"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const remove = (id: string) => setNotices((items) => items.filter((item) => item.id !== id));
  const update = (id: string, changes: Partial<Notice>) =>
    setNotices((items) => items.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  type Input = {
    id: string;
    threadId: string;
    action: "archive" | "delete";
    view: string;
    accountId?: string;
    restore(): void;
    transaction?: ReturnType<typeof optimistic>;
    request?: ReturnType<typeof sentApi.threadAction>;
  };
  const prepare = (input: Input) => {
    input.transaction ??= optimistic(client, {
      threadId: input.threadId,
      action: input.action,
      view: input.view,
      accountId: input.accountId,
    });
    update(input.id, { transaction: input.transaction });
    return input.transaction;
  };
  const mutation = createMutation(() => ({
    mutationFn: (input: Input) =>
      input.request ??
      sentApi.threadAction(input.threadId, input.action, input.view, input.accountId),
    onMutate: prepare,
    onSuccess: (receipt, input, transaction) => {
      transaction?.commit(receipt);
      update(input.id, {
        receipt,
        label: input.action === "archive" ? "Archived" : "Moved to Trash",
      });
    },
    onError: (error, input, transaction) => {
      transaction?.rollback();
      update(input.id, {
        threadId: undefined,
        error: true,
        label: error instanceof Error ? error.message : "Action failed",
      });
      input.restore();
    },
  }));
  const perform: TriageContextValue["perform"] = (
    threadId,
    action,
    advance,
    restore,
    view,
    accountId,
  ) => {
    if (notices().some((notice) => notice.threadId === threadId)) return;
    const id = crypto.randomUUID();
    setNotices((items) => [
      ...items,
      {
        id,
        threadId,
        action,
        label: action === "archive" ? "Archiving…" : "Deleting…",
        onUndo: restore,
      },
    ]);
    const input: Input = { id, threadId, action, view, accountId, restore };
    prepare(input);
    advance();
    input.request = sentApi.threadAction(threadId, action, view, accountId);
    mutation.mutate(input);
  };
  const sent: TriageContextValue["sent"] = (receipt, onUndo) => {
    setNotices((items) => [
      ...items,
      { id: receipt.mutationId, label: "Sending message", receipt, onUndo },
    ]);
  };
  const undo = async (notice: Notice) => {
    if (!notice.receipt) return;
    try {
      const response = await sentApi.undo(notice.receipt.mutationId);
      if (notice.transaction) notice.transaction.rollback(response);
      else await refresh();
      remove(notice.id);
      notice.onUndo?.();
    } catch (error) {
      update(notice.id, {
        threadId: undefined,
        receipt: undefined,
        error: true,
        label: error instanceof Error ? error.message : "Undo failed",
      });
      void refresh();
    }
  };
  return (
    <>
      {
        <TriageContext.Provider
          value={{
            get hiddenThreadIds() {
              return new Set(notices().flatMap((item) => (item.threadId ? [item.threadId] : [])));
            },
            perform,
            sent,
          }}
        >
          {props.children}
          <section class="action-toasts" aria-label="Message actions">
            {notices().map((notice) => (
              <ActionToast
                notice={notice}
                undo={() => undo(notice)}
                dismiss={() => remove(notice.id)}
                expire={async () => {
                  if (!notice.transaction) await refresh();
                  remove(notice.id);
                }}
              />
            ))}
          </section>
        </TriageContext.Provider>
      }
    </>
  );
}
function ActionToast(props: {
  notice: Notice;
  undo(): Promise<void>;
  dismiss(): void;
  expire(): Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);
  const deadline = createMemo(() => props.notice.receipt?.undoUntil);
  createEffect(() => {
    [deadline(), busy(), props.expire];
    const cleanup = untrack(() => {
      if (!deadline() || busy()) return;
      const timer = window.setTimeout(
        () => void props.expire(),
        Math.max(0, Date.parse(deadline() ?? "") - Date.now()),
      );
      return () => window.clearTimeout(timer);
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  return (
    <>
      {
        <div class={`action-toast ${props.notice.error ? "is-error" : ""}`}>
          <span role="status" aria-live="polite">
            {props.notice.action === "archive" ? (
              <Archive size={17} />
            ) : props.notice.action === "delete" ? (
              <Trash2 size={17} />
            ) : (
              <Check size={17} />
            )}
            {props.notice.label}
          </span>
          {deadline() && (
            <button
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                await props.undo();
                setBusy(false);
              }}
            >
              {busy() ? "Undoing…" : "Undo"}
            </button>
          )}
          {props.notice.error && (
            <button aria-label="Dismiss notification" onClick={props.dismiss}>
              <X size={16} />
            </button>
          )}
          {deadline() && (
            <div
              class="toast-timer"
              style={{
                "animation-duration": `${Math.max(0, Date.parse(deadline() ?? "") - Date.now())}ms`,
              }}
            />
          )}
        </div>
      }
    </>
  );
}
export function nextMessageId(
  messages: {
    id: string;
  }[],
  currentId: string,
): string | null {
  const index = messages.findIndex((message) => message.id === currentId);
  if (index < 0) return null;
  return messages[index + 1]?.id ?? messages[index - 1]?.id ?? null;
}
export function visibleConversations<
  Message extends {
    threadId: string;
  },
>(messages: Message[], hiddenThreadIds: Set<string>): Message[] {
  return messages.filter((message) => !hiddenThreadIds.has(message.threadId));
}
