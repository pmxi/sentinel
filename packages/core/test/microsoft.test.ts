import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "../src/config.ts";
import { MicrosoftProvider } from "../src/providers/microsoft.ts";
import type { OutgoingMessage, StoredAccount } from "../src/providers/types.ts";

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

describe("Microsoft sending", () => {
  const MiB = 1024 * 1024;
  const uploadUrl = "https://outlook.office.com/upload?authtoken=secret";
  const graphRoot = "https://graph.microsoft.com/v1.0";
  const draftUrl = `${graphRoot}/me/messages/draft-1`;
  const message: OutgoingMessage = {
    from: account.email,
    to: [{ name: "Recipient", address: "recipient@example.com" }],
    cc: [],
    bcc: [],
    subject: "Attachments",
    body: "See attached.",
    inReplyTo: null,
    replyToProviderMessageId: null,
    forwardOfProviderMessageId: null,
    references: [],
    attachments: [],
  };

  function attachment(size: number) {
    return {
      filename: `file-${size}.bin`,
      contentType: "application/octet-stream",
      contentBase64: Buffer.alloc(size, 0x5a).toString("base64"),
    };
  }

  function setup() {
    const provider = new MicrosoftProvider(async () => undefined);
    vi.spyOn(provider as unknown as ProviderInternals, "token").mockResolvedValue("graph-token");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === uploadUrl) {
        const range = new Headers(init?.headers).get("Content-Range");
        const match = range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!match) throw new Error("Missing byte range");
        const end = Number(match[2]) + 1;
        return end === Number(match[3])
          ? new Response(null, { status: 201 })
          : Response.json({ nextExpectedRanges: [String(end)] });
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/createUploadSession")) return Response.json({ uploadUrl });
      return Response.json({ id: "draft-1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { provider, fetchMock };
  }

  beforeEach(() => {
    vi.stubEnv("MICROSOFT_MAIL_SEND_ENABLED", "true");
    resetEnvForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it.each(["new", "reply", "forward"])(
    "uploads mixed attachments before sending a %s message and accepts empty HTTP 202",
    async (kind) => {
      const { provider, fetchMock } = setup();
      const large = attachment(7 * MiB + 19);
      await expect(
        provider.send(account, {
          ...message,
          replyToProviderMessageId: kind === "reply" ? "source/+" : null,
          forwardOfProviderMessageId: kind === "forward" ? "source/+" : null,
          attachments: [attachment(32), large],
        }),
      ).resolves.toBe("draft-1");

      const first = fetchMock.mock.calls[0];
      expect(first?.[0]).toBe(
        kind === "new"
          ? `${graphRoot}/me/messages`
          : `${graphRoot}/me/messages/source%2F%2B/create${kind === "reply" ? "Reply" : "Forward"}`,
      );
      expect(JSON.parse(String(first?.[1]?.body))).not.toHaveProperty("attachments");
      expect(JSON.parse(String(first?.[1]?.body))).not.toHaveProperty("internetMessageHeaders");
      if (kind !== "new") {
        expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
      }
      const session = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("createUploadSession"),
      );
      expect(JSON.parse(String(session?.[1]?.body))).toEqual({
        AttachmentItem: {
          attachmentType: "file",
          name: large.filename,
          contentType: large.contentType,
          size: 7 * MiB + 19,
        },
      });
      const chunks = fetchMock.mock.calls.filter(([url]) => url === uploadUrl);
      expect(chunks).toHaveLength(3);
      let offset = 0;
      const uploaded = chunks.map(([, init]) => {
        const bytes = init?.body as Buffer;
        const headers = new Headers(init?.headers);
        expect(init?.method).toBe("PUT");
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.get("Content-Type")).toBe("application/octet-stream");
        expect(headers.get("Content-Length")).toBe(String(bytes.length));
        expect(headers.get("Content-Range")).toBe(
          `bytes ${offset}-${offset + bytes.length - 1}/${7 * MiB + 19}`,
        );
        expect(bytes.length).toBeLessThan(4 * MiB);
        offset += bytes.length;
        return bytes;
      });
      expect(Buffer.concat(uploaded).equals(Buffer.from(large.contentBase64, "base64"))).toBe(true);
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${draftUrl}/send`);
    },
  );

  it.each([3 * MiB - 1, 3 * MiB, 3 * MiB + 1])(
    "uses the right upload method for %i bytes",
    async (size) => {
      const { provider, fetchMock } = setup();
      await provider.send(account, { ...message, attachments: [attachment(size)] });
      expect(fetchMock.mock.calls.some(([url]) => url === uploadUrl)).toBe(size >= 3 * MiB);
      expect(fetchMock.mock.calls.some(([url]) => url === `${draftUrl}/attachments`)).toBe(
        size < 3 * MiB,
      );
    },
  );

  it("adds small files separately when their combined size exceeds 3 MB", async () => {
    const { provider, fetchMock } = setup();
    const files = [attachment(2 * MiB), attachment(2 * MiB)];
    await provider.send(account, { ...message, attachments: files });
    const requests = fetchMock.mock.calls.filter(([url]) => url === `${draftUrl}/attachments`);
    expect(requests).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => url === uploadUrl)).toBe(false);
    expect(JSON.parse(String(requests[0]?.[1]?.body)).contentBytes).toBe(files[0]?.contentBase64);
  });

  it.each([404, 429, 500])("does not send when uploading fails with HTTP %i", async (status) => {
    const { provider, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "draft-1" }));
    fetchMock.mockResolvedValueOnce(Response.json({ uploadUrl }));
    fetchMock.mockResolvedValueOnce(new Response("Do not log a signed URL", { status }));
    await expect(
      provider.send(account, { ...message, attachments: [attachment(4 * MiB)] }),
    ).rejects.toThrow(`Microsoft attachment upload failed (HTTP ${status})`);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/send"))).toBe(false);
    expect(fetchMock.mock.calls.at(-1)).toMatchObject([draftUrl, { method: "DELETE" }]);
  });

  it.each([[], ["0-"], ["999999999-"], ["garbage"]])(
    "rejects invalid upload progress %j without sending",
    async (...nextExpectedRanges) => {
      const { provider, fetchMock } = setup();
      fetchMock.mockResolvedValueOnce(Response.json({ id: "draft-1" }));
      fetchMock.mockResolvedValueOnce(Response.json({ uploadUrl }));
      fetchMock.mockResolvedValueOnce(Response.json({ nextExpectedRanges }));
      await expect(
        provider.send(account, { ...message, attachments: [attachment(4 * MiB)] }),
      ).rejects.toThrow("did not confirm progress");
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/send"))).toBe(false);
    },
  );

  it("requires final upload confirmation before sending", async () => {
    const { provider, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "draft-1" }));
    fetchMock.mockResolvedValueOnce(Response.json({ uploadUrl }));
    fetchMock.mockResolvedValueOnce(Response.json({ nextExpectedRanges: [String(3 * MiB)] }));
    await expect(
      provider.send(account, { ...message, attachments: [attachment(3 * MiB)] }),
    ).rejects.toThrow("did not confirm progress");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/send"))).toBe(false);
  });

  it("does not delete the draft after an ambiguous send failure", async () => {
    const { provider, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "draft-1" }));
    fetchMock.mockRejectedValueOnce(new Error("Connection reset"));
    await expect(provider.send(account, message)).rejects.toThrow("Connection reset");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
