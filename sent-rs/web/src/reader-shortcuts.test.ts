import type { Account, MessageDetail, MutationReceipt } from "@sent/shared";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { InboxRoute, SearchRoute } from "./App";
import { sentApi } from "./api";
import { optimistic } from "./mail-cache";
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
  vi.useRealTimers();
});
function mount(
  children: () => ReturnType<typeof createComponent>,
  configure?: (client: QueryClient) => void,
) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("message-list") ? 700 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0") || 0
    );
  });
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
    this.dispatchEvent(new Event("scroll"));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configure?.(client);
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
async function reader(
  read = false,
  empty = false,
  view = "l1",
  accountId?: string,
  pending?: { detail: Promise<MessageDetail>; thread: Promise<{ messages: MessageDetail[] }> },
  configure?: (client: QueryClient) => void,
  readySelector?: string,
) {
  const item = { ...message, read };
  vi.spyOn(sentApi, "session").mockResolvedValue({ authenticated: true });
  vi.spyOn(sentApi, "accounts").mockResolvedValue({ accounts: [account] });
  vi.spyOn(sentApi, "messages").mockResolvedValue({
    messages: empty
      ? []
      : [{ ...item, messageCount: 1, unreadCount: read ? 0 : 1, participants: item.from }],
    nextCursor: null,
  });
  vi.spyOn(sentApi, "message").mockReturnValue(pending?.detail ?? Promise.resolve(item));
  vi.spyOn(sentApi, "thread").mockReturnValue(
    pending?.thread ?? Promise.resolve({ messages: [item] }),
  );
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const path = `/inbox/${view}${empty ? "" : `?message=first${accountId ? `&account=${accountId}` : ""}`}`;
  window.history.replaceState(null, "", path);
  const history = createMemoryHistory();
  history.set({ value: path, replace: true, scroll: false });
  const container = mount(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: App,
        get children() {
          return createComponent(Route, { path: "/inbox/:view", component: InboxRoute });
        },
      }),
    configure,
  );
  await vi.waitFor(() =>
    expect(
      container.querySelector(
        readySelector ??
          (empty ? ".empty-list" : pending ? ".conversation-heading h2" : ".email-body"),
      ),
    ).not.toBeNull(),
  );
  return container;
}
function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("reader triage shortcuts", () => {
  it("positions equal-count, equal-height replacement search results using their new thread keys", async () => {
    const rows = (prefix: string) =>
      Array.from({ length: 2 }, (_, index) => ({
        ...message,
        id: `${prefix}-${index}`,
        threadId: `${prefix}-thread-${index}`,
        subject: `${prefix} ${index}`,
        read: true,
        messageCount: 1,
        unreadCount: 0,
        participants: message.from,
      }));
    vi.spyOn(sentApi, "session").mockResolvedValue({ authenticated: true });
    vi.spyOn(sentApi, "accounts").mockResolvedValue({ accounts: [account] });
    vi.spyOn(sentApi, "search").mockImplementation(async (query) => ({
      messages: rows(query.get("q") ?? ""),
      mode: "lexical",
    }));
    vi.spyOn(sentApi, "thread").mockResolvedValue({ messages: [] });
    vi.spyOn(sentApi, "message").mockResolvedValue({ ...message, read: true });
    const history = createMemoryHistory();
    history.set({ value: "/search?q=first", replace: true, scroll: false });
    const container = mount(() =>
      createComponent(MemoryRouter, {
        history,
        root: App,
        get children() {
          return createComponent(Route, { path: "/search", component: SearchRoute });
        },
      }),
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".message-list-item")).toHaveLength(2),
    );
    const transforms = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".message-list-item")).map(
        (item) => item.style.transform,
      );
    expect(transforms()).toEqual(["translateY(0px)", "translateY(150px)"]);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search mail"]');
    if (!search) throw new Error("Missing search input");
    search.value = "second";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(container.querySelector('button[data-thread-id="second-thread-1"]')).not.toBeNull(),
    );
    expect(transforms()).toEqual(["translateY(0px)", "translateY(150px)"]);
  });
  it("finishes a boundary j after a slow next page is delivered", async () => {
    const first = {
      ...message,
      read: true,
      messageCount: 1,
      unreadCount: 0,
      participants: message.from,
    };
    const after = {
      ...first,
      id: "after",
      threadId: "after-thread",
      subject: "After the first page",
    };
    const rows = [
      ...Array.from({ length: 74 }, (_, index) => ({
        ...first,
        id: `before-${index}`,
        threadId: `before-thread-${index}`,
      })),
      first,
    ];
    let deliver!: (value: { messages: typeof rows; nextCursor: null }) => void;
    const more = new Promise<{ messages: typeof rows; nextCursor: null }>((resolve) => {
      deliver = resolve;
    });
    const container = await reader(true, false, "l1", undefined, undefined, () => {
      vi.mocked(sentApi.messages)
        .mockResolvedValueOnce({ messages: rows, nextCursor: "next" })
        .mockReturnValueOnce(more);
      vi.mocked(sentApi.message).mockImplementation(async (id) => (id === "after" ? after : first));
      vi.mocked(sentApi.thread).mockImplementation(async (id) => ({
        messages: [id === "after-thread" ? after : first],
      }));
    });
    await vi.waitFor(() => expect(sentApi.messages).toHaveBeenCalledTimes(2));
    press("j");
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-thread-id")).toBe(
      "first-thread",
    );
    deliver({ messages: [after], nextCursor: null });
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-thread-id")).toBe(
        "after-thread",
      ),
    );
  });
  it("windows rows and moves keyboard focus into an offscreen thread", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("message-list")
        ? 700
        : this.classList.contains("message-list-item")
          ? 124
          : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (
        Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0") || 0
      );
    });
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
    ) {
      if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
      this.dispatchEvent(new Event("scroll"));
    });
    const rows = Array.from({ length: 75 }, (_, index) => ({
      ...message,
      id: index ? `message-${index}` : "first",
      threadId: index ? `thread-${index}` : "first-thread",
      subject: `Conversation ${index}`,
      read: true,
      messageCount: 1,
      unreadCount: 0,
      participants: message.from,
    }));
    const container = await reader(true, false, "l1", undefined, undefined, () => {
      vi.mocked(sentApi.messages).mockResolvedValue({ messages: rows, nextCursor: null });
      vi.mocked(sentApi.message).mockImplementation(
        async (id) => rows.find((item) => item.id === id) ?? rows[0],
      );
      vi.mocked(sentApi.thread).mockImplementation(async (id) => ({
        messages: rows.filter((item) => item.threadId === id),
      }));
    });
    expect(container.querySelectorAll("button.message-row").length).toBeLessThan(20);
    expect(container.querySelector('button.message-row[data-index="40"]')).toBeNull();
    for (let index = 1; index <= 14; index++) {
      press("j");
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("data-index")).toBe(String(index)),
      );
    }
    expect(container.querySelector(".message-list")?.scrollTop).toBeGreaterThan(0);
    expect(container.querySelectorAll("button.message-row").length).toBeLessThan(25);
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-thread-id")).toBe(
      "thread-14",
    );
  });
  it.each([404, 500])(
    "ends loading when an uncached message fails with %s and has no thread ID",
    async (status) => {
      const request = deferred<MessageDetail>();
      const container = await reader(
        true,
        false,
        "l1",
        undefined,
        undefined,
        () => {
          vi.mocked(sentApi.messages).mockResolvedValue({ messages: [], nextCursor: null });
          vi.mocked(sentApi.message).mockReturnValue(request.promise);
        },
        ".reader",
      );
      expect(container.querySelector(".reader-skeleton")).not.toBeNull();
      request.reject(new Error(status === 404 ? "Message not found" : "Request failed"));
      await vi.waitFor(() => expect(container.textContent).toContain("Message unavailable."));
      expect(container.querySelector(".reader-skeleton")).toBeNull();
      expect(sentApi.thread).not.toHaveBeenCalled();
      expect(press("e").defaultPrevented).toBe(false);
    },
  );
  it("keeps an uncached message loading until detail supplies its thread ID", async () => {
    const request = deferred<MessageDetail>();
    const container = await reader(
      true,
      false,
      "l1",
      undefined,
      undefined,
      () => {
        vi.mocked(sentApi.messages).mockResolvedValue({ messages: [], nextCursor: null });
        vi.mocked(sentApi.message).mockReturnValue(request.promise);
      },
      ".reader",
    );
    expect(container.querySelector(".reader-skeleton")).not.toBeNull();
    expect(container.textContent).not.toContain("Message unavailable.");
    expect(sentApi.thread).not.toHaveBeenCalled();
    request.resolve({ ...message, read: true });
    await vi.waitFor(() =>
      expect(container.querySelector(".email-body")?.textContent).toContain(message.textBody),
    );
    expect(sentApi.thread).toHaveBeenCalledWith(message.threadId, false, expect.any(AbortSignal));
  });
  it("resumes polling an untouched prefetched read conversation after the quiet window", async () => {
    vi.useFakeTimers();
    const item = { ...message, read: true };
    const container = await reader(true, false, "l1", undefined, undefined, (client) => {
      client.setQueryDefaults(["thread"], { staleTime: 15_000 });
      client.setQueryDefaults(["message"], { staleTime: 15_000 });
      client.setQueryData(["message", item.id], item);
      client.setQueryData(["thread", item.threadId, false], { messages: [item] });
      client.setQueryData(["message", "archived"], {
        ...item,
        id: "archived",
        threadId: "archived-thread",
      });
      optimistic(client, { threadId: "archived-thread", action: "archive", view: "l1" }).commit();
    });
    vi.mocked(sentApi.thread).mockResolvedValue({
      messages: [
        item,
        {
          ...item,
          id: "reply",
          textBody: "New reply after archive",
          plainText: "New reply after archive",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(1400);
    expect(sentApi.thread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4200);
    expect(sentApi.thread).toHaveBeenCalledWith(item.threadId, false, expect.any(AbortSignal));
    expect(container.querySelector(".email-body")?.textContent).toContain(
      "New reply after archive",
    );
  });
  it("starts detail and thread together, paints the cached header and then a real thread body", async () => {
    const detail = deferred<MessageDetail>();
    const thread = deferred<{ messages: MessageDetail[] }>();
    const container = await reader(true, false, "l1", undefined, {
      detail: detail.promise,
      thread: thread.promise,
    });
    expect(sentApi.message).toHaveBeenCalled();
    expect(sentApi.thread).toHaveBeenCalled();
    expect(container.querySelector(".conversation-heading h2")?.textContent).toBe(message.subject);
    expect(container.querySelector(".email-body")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[title="Flag"]')?.disabled).toBe(true);
    thread.resolve({ messages: [{ ...message, read: true }] });
    await vi.waitFor(() =>
      expect(container.querySelector(".email-body")?.textContent).toContain(message.textBody),
    );
    expect(container.querySelector<HTMLButtonElement>('button[title="Flag"]')?.disabled).toBe(
      false,
    );
  });
  it.each([
    ["e", "archive"],
    ["#", "delete"],
  ])("keeps %s available during automatic mark-read", async (key, action) => {
    const pending = deferred<MutationReceipt>();
    const request = vi.spyOn(sentApi, "action").mockReturnValue(pending.promise);
    const threadRequest = vi.spyOn(sentApi, "threadAction").mockReturnValue(pending.promise);
    const container = await reader();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("first", "mark_read"));
    expect(
      container.querySelector<HTMLButtonElement>('button[title="Archive conversation"]')?.disabled,
    ).toBe(false);
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
