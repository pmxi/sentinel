import type { MutationReceipt } from "@sent/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Trash2, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { sentApi } from "./api";

type Notice = {
  id: string;
  label: string;
  threadId?: string;
  action?: "archive" | "delete";
  receipt?: MutationReceipt;
  onUndo?: () => void;
  error?: boolean;
};
type TriageContextValue = {
  hiddenThreadIds: Set<string>;
  perform(
    messageId: string,
    action: "archive" | "delete",
    advance: () => void,
    restore: () => void,
    threadId: string,
  ): void;
  sent(receipt: MutationReceipt, onUndo: () => void): void;
};
const TriageContext = createContext<TriageContextValue | null>(null);

export function useTriage() {
  const value = useContext(TriageContext);
  if (!value) throw new Error("Triage context is unavailable");
  return value;
}

export function TriageProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [notices, setNotices] = useState<Notice[]>([]);
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
  const perform: TriageContextValue["perform"] = async (
    messageId,
    action,
    advance,
    restore,
    threadId,
  ) => {
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
    advance();
    try {
      const receipt = await sentApi.action(messageId, action, true);
      update(id, { receipt, label: action === "archive" ? "Archived" : "Moved to Trash" });
      void refresh();
    } catch (error) {
      update(id, {
        threadId: undefined,
        error: true,
        label: error instanceof Error ? error.message : "Action failed",
      });
      restore();
      void refresh();
    }
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
      await sentApi.undo(notice.receipt.mutationId);
      await refresh();
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
    <TriageContext.Provider
      value={{
        hiddenThreadIds: new Set(notices.flatMap((item) => (item.threadId ? [item.threadId] : []))),
        perform,
        sent,
      }}
    >
      {children}
      <section className="action-toasts" aria-label="Message actions">
        {notices.map((notice) => (
          <ActionToast
            key={notice.id}
            notice={notice}
            undo={() => undo(notice)}
            dismiss={() => remove(notice.id)}
            expire={async () => {
              await refresh();
              remove(notice.id);
            }}
          />
        ))}
      </section>
    </TriageContext.Provider>
  );
}

function ActionToast({
  notice,
  undo,
  dismiss,
  expire,
}: {
  notice: Notice;
  undo(): Promise<void>;
  dismiss(): void;
  expire(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const deadline = notice.receipt?.undoUntil;
  useEffect(() => {
    if (!deadline || busy) return;
    const timer = window.setTimeout(
      () => void expire(),
      Math.max(0, Date.parse(deadline) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [deadline, busy, expire]);
  return (
    <div className={`action-toast ${notice.error ? "is-error" : ""}`}>
      <span role="status" aria-live="polite">
        {notice.action === "archive" ? (
          <Archive size={17} />
        ) : notice.action === "delete" ? (
          <Trash2 size={17} />
        ) : (
          <Check size={17} />
        )}
        {notice.label}
      </span>
      {deadline && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await undo();
            setBusy(false);
          }}
        >
          {busy ? "Undoing…" : "Undo"}
        </button>
      )}
      {notice.error && (
        <button aria-label="Dismiss notification" onClick={dismiss}>
          <X size={16} />
        </button>
      )}
      {deadline && (
        <div
          className="toast-timer"
          style={{ animationDuration: `${Math.max(0, Date.parse(deadline) - Date.now())}ms` }}
        />
      )}
    </div>
  );
}

export function nextMessageId(messages: { id: string }[], currentId: string): string | null {
  const index = messages.findIndex((message) => message.id === currentId);
  if (index < 0) return null;
  return messages[index + 1]?.id ?? messages[index - 1]?.id ?? null;
}

export function visibleConversations<Message extends { threadId: string }>(
  messages: Message[],
  hiddenThreadIds: Set<string>,
): Message[] {
  return messages.filter((message) => !hiddenThreadIds.has(message.threadId));
}
