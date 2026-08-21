import { describe, expect, it, vi } from "vitest";
import { MicrosoftProvider } from "../src/providers/microsoft.ts";
import type { StoredAccount } from "../src/providers/types.ts";

const account: StoredAccount = {
  id: "account-1",
  provider: "microsoft",
  email: "paras@example.edu",
  displayName: "Paras",
  encryptedCredentials: "unused-in-test",
};

const cursor = JSON.stringify({
  version: 1,
  folders: [
    {
      id: "inbox",
      name: "Inbox",
      delta: "https://graph.example/delta",
      next: null,
    },
  ],
  index: 0,
  backfill: false,
  folderRefreshAt: new Date().toISOString(),
});

const fullMessage = {
  id: "message-1",
  conversationId: "thread-1",
  internetMessageId: "<message-1@example.com>",
  subject: "A complete message",
  from: { emailAddress: { name: "Ada", address: "ada@example.com" } },
  toRecipients: [{ emailAddress: { name: "Paras", address: "paras@example.edu" } }],
  ccRecipients: [],
  bccRecipients: [],
  sentDateTime: "2026-08-20T12:00:00Z",
  receivedDateTime: "2026-08-20T12:00:01Z",
  lastModifiedDateTime: "2026-08-20T12:05:00Z",
  bodyPreview: "Hello Paras",
  body: { contentType: "text" as const, content: "Hello Paras" },
  isRead: true,
  flag: { flagStatus: "notFlagged" },
  parentFolderId: "inbox",
  isDraft: false,
  hasAttachments: false,
};

type ProviderInternals = {
  token(account: StoredAccount): Promise<string>;
  graph(token: string, url: string): Promise<unknown>;
};

function testProvider() {
  const provider = new MicrosoftProvider(async () => undefined);
  const internals = provider as unknown as ProviderInternals;
  vi.spyOn(internals, "token").mockResolvedValue("token");
  return { provider, graph: vi.spyOn(internals, "graph") };
}

describe("Microsoft delta synchronization", () => {
  it("hydrates patch-like delta updates before normalizing them", async () => {
    const { provider, graph } = testProvider();
    graph.mockImplementation(async (_token, url) => {
      if (url === "https://graph.example/delta") {
        return {
          value: [{ id: "message-1", isRead: true, parentFolderId: "inbox" }],
          "@odata.deltaLink": "https://graph.example/next-delta",
        };
      }
      if (url.startsWith("/me/messages/message-1?")) return fullMessage;
      throw new Error(`Unexpected Graph URL: ${url}`);
    });

    const page = await provider.sync(account, cursor);

    expect(graph).toHaveBeenCalledTimes(2);
    expect(graph.mock.calls[1]?.[1]).toContain("/me/messages/message-1?$select=");
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      providerMessageId: "message-1",
      providerThreadId: "thread-1",
      subject: "A complete message",
      from: [{ name: "Ada", address: "ada@example.com" }],
      textBody: "Hello Paras",
      direction: "inbound",
      read: true,
    });
    expect(page.messages[0]?.receivedAt.toISOString()).toBe("2026-08-20T12:00:01.000Z");
    expect(page.messages[0]?.providerUpdatedAt?.toISOString()).toBe("2026-08-20T12:05:00.000Z");
  });

  it("does not refetch complete delta records", async () => {
    const { provider, graph } = testProvider();
    graph.mockResolvedValue({
      value: [fullMessage],
      "@odata.deltaLink": "https://graph.example/next-delta",
    });

    const page = await provider.sync(account, cursor);

    expect(graph).toHaveBeenCalledTimes(1);
    expect(page.messages[0]?.subject).toBe("A complete message");
  });

  it("tombstones a partial delta record that no longer exists", async () => {
    const { provider, graph } = testProvider();
    graph.mockImplementation(async (_token, url) => {
      if (url === "https://graph.example/delta") {
        return {
          value: [{ id: "deleted-message", isRead: true }],
          "@odata.deltaLink": "https://graph.example/next-delta",
        };
      }
      throw new Error("Microsoft Graph 404: message not found");
    });

    const page = await provider.sync(account, cursor);

    expect(page.messages).toEqual([]);
    expect(page.deletedProviderMessageIds).toEqual(["deleted-message"]);
  });

  it("rejects complete non-draft snapshots without a real timestamp", async () => {
    const { provider, graph } = testProvider();
    graph.mockResolvedValue({
      value: [{ ...fullMessage, sentDateTime: null, receivedDateTime: null }],
      "@odata.deltaLink": "https://graph.example/next-delta",
    });

    await expect(provider.sync(account, cursor)).rejects.toThrow(
      "is missing its received and sent timestamps",
    );
  });
});
