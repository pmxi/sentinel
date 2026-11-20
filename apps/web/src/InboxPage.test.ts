// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import { CommandProvider } from "./commands";
import { ComposeProvider } from "./compose";
import { InboxPage } from "./InboxPage";
import { TriageProvider } from "./triage";

vi.mock("./api", () => ({
  sentApi: {
    messages: vi.fn(),
    message: vi.fn(),
    thread: vi.fn(),
    action: vi.fn(),
    threadAction: vi.fn(),
  },
}));

const message = {
  id: "message-1",
  threadId: "thread-1",
  account: { id: "account-1", email: "me@example.test", displayName: "Me", provider: "gmail" },
  subject: "Pending read regression",
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [],
  participants: [],
  receivedAt: "2026-01-01T00:00:00Z",
  read: false,
  flagged: false,
  tier: 1,
  modelTier: 1,
  textBody: "Synthetic email",
  attachments: [],
  messageCount: 1,
  unreadCount: 1,
};

function mount(entry = "/inbox/l1?message=message-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(
          TriageProvider,
          null,
          createElement(
            ComposeProvider,
            // biome-ignore lint/correctness/noChildrenProp: createElement requires the non-optional children prop.
            { accounts: [], children: null },
            createElement(
              CommandProvider,
              null,
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: "/inbox/:view",
                  element: createElement(InboxPage, { accounts: [] }),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return { ...ui, client };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/inbox/l1");
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(sentApi.messages).mockResolvedValue({ messages: [message] } as never);
  vi.mocked(sentApi.message).mockResolvedValue(message as never);
  vi.mocked(sentApi.thread).mockResolvedValue({ messages: [message] } as never);
  vi.mocked(sentApi.threadAction).mockResolvedValue({ mutationId: "archive-1", undoUntil: null });
});
afterEach(cleanup);

describe("archive while automatic mark-read is pending", () => {
  it.each(["success", "error"])(
    "archives immediately and stays hidden after read %s",
    async (outcome) => {
      let resolveRead!: (value: never) => void;
      let rejectRead!: (error: Error) => void;
      const read = new Promise<never>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      vi.mocked(sentApi.action).mockImplementation((_id, action) =>
        action === "mark_read" ? read : Promise.resolve({ mutationId: "archive-1" }),
      );
      const { container, client } = mount();
      await waitFor(() => expect(sentApi.action).toHaveBeenCalledWith("message-1", "mark_read"));
      // Let the pending mutation render before dispatching the shortcut.
      await act(async () => {});
      fireEvent.keyDown(window, { key: "e" });
      await waitFor(() =>
        expect(sentApi.threadAction).toHaveBeenCalledWith("thread-1", "archive", "l1", undefined),
      );
      expect(container.querySelector(".message-row")).toBeNull();
      expect(screen.queryByRole("heading", { name: message.subject })).toBeNull();
      await act(async () => {
        if (outcome === "success") resolveRead({} as never);
        else rejectRead(new Error("Mark-read failed"));
      });
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(container.querySelector(".message-row")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("Archived")).toBeTruthy();
      client.clear();
    },
  );

  it("does not archive without a selected message", async () => {
    vi.mocked(sentApi.message).mockResolvedValue(undefined as never);
    const { client } = mount();
    await screen.findByText("Message unavailable.");
    fireEvent.keyDown(window, { key: "e" });
    expect(sentApi.action).not.toHaveBeenCalled();
    expect(sentApi.threadAction).not.toHaveBeenCalled();
    client.clear();
  });

  it("deletes the conversation with the current view and account scope", async () => {
    const { client } = mount("/inbox/l2?message=message-1&account=account-1");
    fireEvent.click(await screen.findByRole("button", { name: "Delete conversation" }));
    await waitFor(() =>
      expect(sentApi.threadAction).toHaveBeenCalledWith("thread-1", "delete", "l2", "account-1"),
    );
    expect(screen.getByText("Moved to Trash")).toBeTruthy();
    client.clear();
  });

  it("restores the conversation when the grouped request fails", async () => {
    vi.mocked(sentApi.threadAction).mockRejectedValue(new Error("Thread action failed"));
    const { container, client } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await screen.findByText("Thread action failed");
    await waitFor(() => expect(container.querySelector(".message-row")).not.toBeNull());
    client.clear();
  });
});
