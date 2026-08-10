import { ConfidentialClientApplication, type Configuration } from "@azure/msal-node";
import type { MailAddress } from "@sent/shared";
import { env, requireConfig } from "../config.ts";
import { decryptSecret, encryptSecret } from "../crypto.ts";
import { sanitizeEmailHtml, snippetFromText, textFromHtml } from "./normalize.ts";
import type {
  MailProvider,
  NormalizedMessage,
  OutgoingMessage,
  ProviderAction,
  StoredAccount,
  SyncPage,
} from "./types.ts";

type GraphRecipient = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: "html" | "text"; content?: string };
  isRead?: boolean;
  flag?: { flagStatus?: string };
  parentFolderId?: string;
  isDraft?: boolean;
  hasAttachments?: boolean;
  "@removed"?: { reason?: string };
};

type MicrosoftCredentials = { cache: string; homeAccountId: string };
type FolderCursor = { id: string; name: string; delta: string | null; next: string | null };
type MicrosoftCursor = {
  version: 1;
  folders: FolderCursor[];
  index: number;
  backfill: boolean;
  folderRefreshAt: string;
};
const BASE_GRAPH_SCOPES = ["openid", "profile", "offline_access", "Mail.ReadWrite"];
const SELECT =
  "id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,bodyPreview,body,isRead,flag,parentFolderId,isDraft,hasAttachments";

function addresses(recipients: GraphRecipient[] | undefined): MailAddress[] {
  return (recipients ?? []).flatMap((recipient) =>
    recipient.emailAddress?.address
      ? [
          {
            name: recipient.emailAddress.name ?? "",
            address: recipient.emailAddress.address.toLowerCase(),
          },
        ]
      : [],
  );
}

export class MicrosoftProvider implements MailProvider {
  readonly provider = "microsoft" as const;

  constructor(
    private readonly persistCredentials: (accountId: string, encrypted: string) => Promise<void>,
  ) {}

  private configuration(): Configuration {
    return {
      auth: {
        clientId: requireConfig("MICROSOFT_CLIENT_ID"),
        clientSecret: requireConfig("MICROSOFT_CLIENT_SECRET"),
        authority: `https://login.microsoftonline.com/${env().MICROSOFT_TENANT_ID}`,
      },
    };
  }

  private app(): ConfidentialClientApplication {
    return new ConfidentialClientApplication(this.configuration());
  }

  private scopes(): string[] {
    return [...BASE_GRAPH_SCOPES, ...(env().MICROSOFT_MAIL_SEND_ENABLED ? ["Mail.Send"] : [])];
  }

  private async token(account: StoredAccount): Promise<string> {
    const credentials = JSON.parse(
      decryptSecret(account.encryptedCredentials, requireConfig("TOKEN_ENCRYPTION_KEY")),
    ) as MicrosoftCredentials;
    const app = this.app();
    app.getTokenCache().deserialize(credentials.cache);
    const cachedAccount = (await app.getTokenCache().getAllAccounts()).find(
      (item) => item.homeAccountId === credentials.homeAccountId,
    );
    if (!cachedAccount)
      throw new Error("Microsoft account is missing from the encrypted token cache");
    const result = await app.acquireTokenSilent({ account: cachedAccount, scopes: this.scopes() });
    const cache = app.getTokenCache().serialize();
    if (cache !== credentials.cache) {
      await this.persistCredentials(
        account.id,
        encryptSecret(
          JSON.stringify({ ...credentials, cache }),
          requireConfig("TOKEN_ENCRYPTION_KEY"),
        ),
      );
    }
    return result.accessToken;
  }

  private async graph<T>(token: string, url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(
      url.startsWith("http") ? url : `https://graph.microsoft.com/v1.0${url}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: 'IdType="ImmutableId"',
          ...(init?.headers ?? {}),
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Microsoft Graph ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  async getAuthorizationUrl(state: string): Promise<string> {
    return this.app().getAuthCodeUrl({
      scopes: this.scopes(),
      redirectUri: `${env().SENT_PUBLIC_URL}/api/oauth/microsoft/callback`,
      state,
      prompt: "select_account",
    });
  }

  async exchangeAuthorizationCode(code: string) {
    const app = this.app();
    const result = await app.acquireTokenByCode({
      code,
      scopes: this.scopes(),
      redirectUri: `${env().SENT_PUBLIC_URL}/api/oauth/microsoft/callback`,
    });
    if (!result?.account) throw new Error("Microsoft authorization did not return an account");
    const email = result.account.username.toLowerCase();
    const credentials: MicrosoftCredentials = {
      cache: app.getTokenCache().serialize(),
      homeAccountId: result.account.homeAccountId,
    };
    return {
      email,
      displayName: result.account.name ?? email,
      credentials: encryptSecret(
        JSON.stringify(credentials),
        requireConfig("TOKEN_ENCRYPTION_KEY"),
      ),
    };
  }

  private async normalize(
    token: string,
    source: GraphMessage,
    accountEmail: string,
    folder: FolderCursor,
  ): Promise<NormalizedMessage | null> {
    if (source["@removed"] || !source.id) return null;
    const rawBody = source.body?.content ?? "";
    const htmlBody =
      source.body?.contentType?.toLowerCase() === "html" ? sanitizeEmailHtml(rawBody) : null;
    const textBody = htmlBody ? textFromHtml(htmlBody) : rawBody;
    const attachments = source.hasAttachments
      ? (
          await this.graph<{
            value: Array<{
              id: string;
              name?: string;
              contentType?: string;
              size?: number;
              isInline?: boolean;
              contentId?: string;
            }>;
          }>(
            token,
            `/me/messages/${encodeURIComponent(source.id)}/attachments?$select=id,name,contentType,size,isInline`,
          )
        ).value.map((item) => ({
          id: item.id,
          filename: item.name ?? "attachment",
          contentType: item.contentType ?? "application/octet-stream",
          size: item.size ?? 0,
          inline: item.isInline ?? false,
          contentId: item.contentId ?? null,
        }))
      : [];
    const from = addresses(source.from ? [source.from] : []);
    const receivedAt = new Date(source.receivedDateTime ?? source.sentDateTime ?? Date.now());
    const deleted = /^(deleted items|trash)$/i.test(folder.name);
    const archived = /^archive$/i.test(folder.name);
    return {
      providerMessageId: source.id,
      providerThreadId: source.conversationId ?? source.id,
      internetMessageId: source.internetMessageId ?? null,
      subject: source.subject ?? "(no subject)",
      from,
      to: addresses(source.toRecipients),
      cc: addresses(source.ccRecipients),
      bcc: addresses(source.bccRecipients),
      sentAt: source.sentDateTime ? new Date(source.sentDateTime) : null,
      receivedAt,
      snippet: source.bodyPreview ?? snippetFromText(textBody),
      textBody,
      htmlBody,
      headers: {},
      attachments,
      direction: from.some((item) => item.address === accountEmail.toLowerCase())
        ? "outbound"
        : "inbound",
      read: source.isRead ?? false,
      flagged: source.flag?.flagStatus === "flagged",
      archived,
      deleted,
      tombstone: source.isDraft ?? false,
      containers: [{ id: source.parentFolderId ?? folder.id, name: folder.name, kind: "folder" }],
      nativeState: { parentFolderId: source.parentFolderId, isDraft: source.isDraft },
      providerUpdatedAt: receivedAt,
    };
  }

  private async listFolders(token: string): Promise<FolderCursor[]> {
    const folders: FolderCursor[] = [];
    const visit = async (initialUrl: string): Promise<void> => {
      let url: string | undefined = initialUrl;
      while (url) {
        const page: {
          value: Array<{ id: string; displayName?: string; childFolderCount?: number }>;
          "@odata.nextLink"?: string;
        } = await this.graph(token, url);
        for (const folder of page.value) {
          folders.push({
            id: folder.id,
            name: folder.displayName ?? "Folder",
            delta: null,
            next: null,
          });
          if ((folder.childFolderCount ?? 0) > 0) {
            await visit(
              `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount`,
            );
          }
        }
        url = page["@odata.nextLink"];
      }
    };
    await visit(
      "/me/mailFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount",
    );
    return folders;
  }

  async sync(account: StoredAccount, cursor: string | null): Promise<SyncPage> {
    const token = await this.token(account);
    let state: MicrosoftCursor | null = cursor ? (JSON.parse(cursor) as MicrosoftCursor) : null;
    if (!state) {
      state = {
        version: 1,
        folders: await this.listFolders(token),
        index: 0,
        backfill: true,
        folderRefreshAt: new Date().toISOString(),
      };
      return {
        messages: [],
        deletedProviderMessageIds: [],
        nextCursor: JSON.stringify(state),
        backfillComplete: false,
      };
    }
    if (
      !state.backfill &&
      Date.now() - new Date(state.folderRefreshAt).getTime() > 6 * 60 * 60 * 1000
    ) {
      const previous = new Map(state.folders.map((folder) => [folder.id, folder]));
      state.folders = (await this.listFolders(token)).map(
        (folder) => previous.get(folder.id) ?? folder,
      );
      state.folderRefreshAt = new Date().toISOString();
      state.index = Math.min(state.index, Math.max(0, state.folders.length - 1));
    }
    const folder = state.folders[state.index];
    if (!folder) {
      state.index = 0;
      state.backfill = false;
      return {
        messages: [],
        deletedProviderMessageIds: [],
        nextCursor: JSON.stringify(state),
        backfillComplete: true,
      };
    }
    const url =
      folder.next ??
      folder.delta ??
      `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?$select=${SELECT}&$top=50`;
    const page = await this.graph<{
      value: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>(token, url);
    const messages: NormalizedMessage[] = [];
    const deletedProviderMessageIds: string[] = [];
    for (const source of page.value) {
      if (source["@removed"] && source.id) deletedProviderMessageIds.push(source.id);
      else {
        const normalized = await this.normalize(token, source, account.email, folder);
        if (normalized) messages.push(normalized);
      }
    }
    if (page["@odata.nextLink"]) folder.next = page["@odata.nextLink"];
    else {
      folder.next = null;
      folder.delta = page["@odata.deltaLink"] ?? folder.delta;
      state.index += 1;
      if (state.index >= state.folders.length) {
        state.index = 0;
        state.backfill = false;
      }
    }
    return {
      messages,
      deletedProviderMessageIds,
      nextCursor: JSON.stringify(state),
      backfillComplete: !state.backfill,
    };
  }

  async applyAction(
    account: StoredAccount,
    providerMessageId: string,
    action: ProviderAction,
  ): Promise<void> {
    const token = await this.token(account);
    const id = encodeURIComponent(providerMessageId);
    if (action === "delete") {
      await this.graph<void>(token, `/me/messages/${id}`, { method: "DELETE" });
      return;
    }
    if (action === "archive") {
      await this.graph(token, `/me/messages/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ destinationId: "archive" }),
      });
      return;
    }
    const body =
      action === "mark_read" || action === "mark_unread"
        ? { isRead: action === "mark_read" }
        : { flag: { flagStatus: action === "flag" ? "flagged" : "notFlagged" } };
    await this.graph(token, `/me/messages/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  async send(account: StoredAccount, message: OutgoingMessage): Promise<string> {
    if (!env().MICROSOFT_MAIL_SEND_ENABLED) {
      throw new Error("Sending from Purdue requires Microsoft Mail.Send approval");
    }
    const token = await this.token(account);
    const recipient = (item: MailAddress) => ({
      emailAddress: { name: item.name, address: item.address },
    });
    const messageBody = {
      subject: message.subject,
      body: { contentType: "Text", content: message.body },
      toRecipients: message.to.map(recipient),
      ccRecipients: message.cc.map(recipient),
      bccRecipients: message.bcc.map(recipient),
    };
    const sourceId = message.replyToProviderMessageId ?? message.forwardOfProviderMessageId;
    if (sourceId) {
      const operation = message.replyToProviderMessageId ? "createReply" : "createForward";
      const draft = await this.graph<{ id: string }>(
        token,
        `/me/messages/${encodeURIComponent(sourceId)}/${operation}`,
        { method: "POST", body: "{}" },
      );
      await this.graph(token, `/me/messages/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        body: JSON.stringify(messageBody),
      });
      for (const attachment of message.attachments) {
        await this.graph(token, `/me/messages/${encodeURIComponent(draft.id)}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: attachment.filename,
            contentType: attachment.contentType,
            contentBytes: attachment.contentBase64,
          }),
        });
      }
      await this.graph<void>(token, `/me/messages/${encodeURIComponent(draft.id)}/send`, {
        method: "POST",
      });
      return draft.id;
    }
    const response = await this.graph<{ id: string }>(token, "/me/messages", {
      method: "POST",
      body: JSON.stringify({
        ...messageBody,
        internetMessageHeaders: message.inReplyTo
          ? [{ name: "In-Reply-To", value: message.inReplyTo }]
          : [],
        attachments: message.attachments.map((attachment) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.filename,
          contentType: attachment.contentType,
          contentBytes: attachment.contentBase64,
        })),
      }),
    });
    await this.graph<void>(token, `/me/messages/${encodeURIComponent(response.id)}/send`, {
      method: "POST",
    });
    return response.id;
  }

  async fetchAttachment(account: StoredAccount, providerMessageId: string, attachmentId: string) {
    const token = await this.token(account);
    const attachment = await this.graph<{
      name?: string;
      contentType?: string;
      contentBytes?: string;
    }>(
      token,
      `/me/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (!attachment.contentBytes) throw new Error("Graph attachment did not include bytes");
    return {
      bytes: Buffer.from(attachment.contentBytes, "base64"),
      contentType: attachment.contentType ?? "application/octet-stream",
      filename: attachment.name ?? "attachment",
    };
  }
}
