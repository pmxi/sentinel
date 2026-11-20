import type { Account, MessageDetail, MutationReceipt } from "@sent/shared";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { InboxRoute } from "./App";
import { sentApi } from "./api";
import { TriageProvider, useTriage } from "./triage";

const account: Account = {
  id: "account",
  provider: "gmail",
  email: "owner@example.test",
  displayName: "Owner",
  status: "active",
  lastSyncedAt: null,
};
const message: MessageDetail = {
  id: "first",
  threadId: "first-thread",
  account,
  subject: "First conversation",
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [],
  cc: [],
  bcc: [],
  snippet: "Reader body",
  receivedAt: "2026-11-20T00:00:00.000Z",
  sentAt: null,
  read: false,
  flagged: false,
  direction: "inbound",
  tier: 1,
  modelTier: null,
  reasoning: null,
  aiSummary: null,
  attachmentCount: 0,
  attachments: [],
  syncPending: false,
  textBody: "Reader body",
  htmlBody: null,
  plainText: "Reader body",
  internetMessageId: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});
function mount(children: () => ReturnType<typeof createComponent>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          return children();
        },
      }),
    container,
  );
  cleanups.push(() => {
    dispose();
    client.clear();
    container.remove();
  });
  return container;
}
async function reader(read = false, empty = false, view = "l1", accountId?: string) {
  const item = { ...message, read };
  vi.spyOn(sentApi, "session").mockResolvedValue({ authenticated: true });
  vi.spyOn(sentApi, "accounts").mockResolvedValue({ accounts: [account] });
  vi.spyOn(sentApi, "messages").mockResolvedValue({
    messages: empty
      ? []
      : [{ ...item, messageCount: 1, unreadCount: read ? 0 : 1, participants: item.from }],
    nextCursor: null,
  });
  vi.spyOn(sentApi, "message").mockResolvedValue(item);
  vi.spyOn(sentApi, "thread").mockResolvedValue({ messages: [item] });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const path = `/inbox/${view}${empty ? "" : `?message=first${accountId ? `&account=${accountId}` : ""}`}`;
  window.history.replaceState(null, "", path);
  const history = createMemoryHistory();
  history.set({ value: path, replace: true, scroll: false });
  const container = mount(() =>
    createComponent(MemoryRouter, {
      history,
      root: App,
      get children() {
        return createComponent(Route, { path: "/inbox/:view", component: InboxRoute });
      },
    }),
  );
  await vi.waitFor(() =>
    expect(container.querySelector(empty ? ".empty-list" : ".email-body")).not.toBeNull(),
  );
  return container;
}
function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("reader triage shortcuts", () => {
  it.each([
    ["e", "archive"],
    ["#", "delete"],
  ])("keeps %s available during automatic mark-read", async (key, action) => {
    const pending = deferred<MutationReceipt>();
    const request = vi.spyOn(sentApi, "action").mockReturnValue(pending.promise);
    const threadRequest = vi.spyOn(sentApi, "threadAction").mockReturnValue(pending.promise);
    const container = await reader();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("first", "mark_read"));
    expect(press(key).defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(threadRequest).toHaveBeenCalledWith("first-thread", action, "l1", undefined),
    );
    expect(container.querySelector("button.message-row")).toBeNull();
  });

  it("blocks archive during a manual mark-unread, matching React", async () => {
    const request = vi
      .spyOn(sentApi, "action")
      .mockReturnValue(deferred<MutationReceipt>().promise);
    await reader(true);
    press("u");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("first", "mark_unread"));
    expect(press("e").defaultPrevented).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("still blocks triage during other pending mutations", async () => {
    const pending = deferred<MutationReceipt>();
    const request = vi.spyOn(sentApi, "action").mockReturnValue(pending.promise);
    await reader(true);
    press("s");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("first", "flag"));
    expect(press("e").defaultPrevented).toBe(false);
    expect(press("#").defaultPrevented).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not triage an empty reader", async () => {
    const request = vi.spyOn(sentApi, "action");
    const threadRequest = vi.spyOn(sentApi, "threadAction");
    await reader(true, true);
    expect(press("e").defaultPrevented).toBe(false);
    expect(press("#").defaultPrevented).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(threadRequest).not.toHaveBeenCalled();
  });

  it("allows triage after automatic mark-read fails", async () => {
    const pending = deferred<MutationReceipt>();
    const request = vi
      .spyOn(sentApi, "action")
      .mockReturnValueOnce(pending.promise)
      .mockReturnValue(deferred<MutationReceipt>().promise);
    const container = await reader();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("first", "mark_read"));
    pending.reject(new Error("Mark-read failed"));
    const threadRequest = vi
      .spyOn(sentApi, "threadAction")
      .mockReturnValue(deferred<MutationReceipt>().promise);
    press("e");
    await vi.waitFor(() =>
      expect(threadRequest).toHaveBeenCalledWith("first-thread", "archive", "l1", undefined),
    );
    expect(container.querySelector("button.message-row")).toBeNull();
  });

  it("sends conversation delete with the current view and account scope", async () => {
    const request = vi
      .spyOn(sentApi, "threadAction")
      .mockReturnValue(deferred<MutationReceipt>().promise);
    const container = await reader(true, false, "l2", "account");
    (container.querySelector('[aria-label="Delete conversation"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("first-thread", "delete", "l2", "account"),
    );
    expect(container.querySelector("button.message-row")).toBeNull();
  });

  it("restores the conversation when its grouped request fails", async () => {
    vi.spyOn(sentApi, "threadAction").mockRejectedValue(new Error("Thread action failed"));
    const container = await reader(true);
    (container.querySelector('[aria-label="Archive conversation"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.textContent).toContain("Thread action failed"));
    expect(container.querySelector("button.message-row")).not.toBeNull();
  });
});

describe("triage submission protection", () => {
  it("prevents duplicate archive/delete and permits retry after failure", async () => {
    const pending = deferred<MutationReceipt>();
    const request = vi
      .spyOn(sentApi, "threadAction")
      .mockReturnValueOnce(pending.promise)
      .mockReturnValue(deferred<MutationReceipt>().promise);
    let triage!: ReturnType<typeof useTriage>;
    const advance = vi.fn();
    const restore = vi.fn();
    const container = mount(() =>
      createComponent(TriageProvider, {
        get children() {
          triage = useTriage();
          return null;
        },
      }),
    );
    triage.perform("first-thread", "archive", advance, restore, "l1");
    triage.perform("first-thread", "archive", advance, restore, "l1");
    triage.perform("first-thread", "delete", advance, restore, "l1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(triage.hiddenThreadIds.has("first-thread")).toBe(true);
    pending.reject(new Error("Archive failed"));
    await vi.waitFor(() => expect(container.textContent).toContain("Archive failed"));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(triage.hiddenThreadIds.has("first-thread")).toBe(false);
    triage.perform("first-thread", "delete", advance, restore, "l1");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
