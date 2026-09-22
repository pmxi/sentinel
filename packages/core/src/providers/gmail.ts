import type { gmail_v1 } from "googleapis";
import { google } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { env, requireConfig } from "../config.ts";
import { decryptSecret, encryptSecret } from "../crypto.ts";
import {
  decodeBase64Url,
  parseAddresses,
  sanitizeEmailHtml,
  snippetFromText,
  textFromHtml,
} from "./normalize.ts";
import type {
  MailProvider,
  NormalizedMessage,
  OutgoingMessage,
  ProviderAction,
  StoredAccount,
  SyncPage,
} from "./types.ts";

type GmailCredentials = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
};

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
  "profile",
];

function headerMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (headers ?? []).flatMap((header) =>
      header.name && header.value ? [[header.name.toLowerCase(), header.value]] : [],
    ),
  );
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined): gmail_v1.Schema$MessagePart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(walkParts)];
}

function normalizeGmailMessage(
  message: gmail_v1.Schema$Message,
  accountEmail: string,
): NormalizedMessage {
  if (!message.id || !message.threadId) throw new Error("Gmail returned a message without an id");
  const headers = headerMap(message.payload?.headers);
  const parts = walkParts(message.payload);
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data)?.body?.data;
  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data)?.body?.data;
  const htmlBody = html ? sanitizeEmailHtml(decodeBase64Url(html)) : null;
  const textBody = plain ? decodeBase64Url(plain) : htmlBody ? textFromHtml(htmlBody) : "";
  const labels = message.labelIds ?? [];
  const receivedAt = new Date(Number(message.internalDate ?? Date.now()));
  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    internetMessageId: headers["message-id"] ?? null,
    subject: headers.subject ?? "(no subject)",
    from: parseAddresses(headers.from),
    to: parseAddresses(headers.to),
    cc: parseAddresses(headers.cc),
    bcc: parseAddresses(headers.bcc),
    sentAt: headers.date ? new Date(headers.date) : null,
    receivedAt,
    snippet: message.snippet ?? snippetFromText(textBody),
    textBody,
    htmlBody,
    headers,
    attachments: parts.flatMap((part) => {
      if (!part.filename || !part.body?.attachmentId) return [];
      const partHeaders = headerMap(part.headers);
      return [
        {
          id: part.body.attachmentId,
          filename: part.filename,
          contentType: part.mimeType ?? "application/octet-stream",
          size: part.body.size ?? 0,
          inline: (partHeaders["content-disposition"] ?? "").toLowerCase().startsWith("inline"),
          contentId: partHeaders["content-id"]?.replace(/^<|>$/g, "") ?? null,
        },
      ];
    }),
    direction:
      labels.includes("SENT") ||
      parseAddresses(headers.from).some((item) => item.address === accountEmail.toLowerCase())
        ? "outbound"
        : "inbound",
    read: !labels.includes("UNREAD"),
    flagged: labels.includes("STARRED"),
    archived: !labels.includes("INBOX") && !labels.includes("SENT") && !labels.includes("TRASH"),
    deleted: labels.includes("TRASH"),
    tombstone: labels.includes("DRAFT"),
    containers: labels.map((id) => ({ id, name: id, kind: "label" })),
    nativeState: { labelIds: labels, historyId: message.historyId },
    providerUpdatedAt: receivedAt,
  };
}

export class GmailProvider implements MailProvider {
  readonly provider = "gmail" as const;

  constructor(
    private readonly persistCredentials: (accountId: string, encrypted: string) => Promise<void>,
  ) {}

  private oauth() {
    return new google.auth.OAuth2(
      requireConfig("GOOGLE_CLIENT_ID"),
      requireConfig("GOOGLE_CLIENT_SECRET"),
      `${env().SENT_PUBLIC_URL}/api/oauth/gmail/callback`,
    );
  }

  private async client(account: StoredAccount): Promise<gmail_v1.Gmail> {
    const oauth = this.oauth();
    const credentials = JSON.parse(
      decryptSecret(account.encryptedCredentials, requireConfig("TOKEN_ENCRYPTION_KEY")),
    ) as GmailCredentials;
    oauth.setCredentials(credentials);
    oauth.on("tokens", (tokens) => {
      const next = {
        ...credentials,
        ...tokens,
        refresh_token: tokens.refresh_token ?? credentials.refresh_token,
      };
      void this.persistCredentials(
        account.id,
        encryptSecret(JSON.stringify(next), requireConfig("TOKEN_ENCRYPTION_KEY")),
      );
    });
    return google.gmail({ version: "v1", auth: oauth });
  }

  async getAuthorizationUrl(state: string): Promise<string> {
    return this.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state,
    });
  }

  async exchangeAuthorizationCode(code: string) {
    const oauth = this.oauth();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const profile = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
    if (!profile.data.email) throw new Error("Google profile did not include an email address");
    return {
      email: profile.data.email,
      displayName: profile.data.name ?? profile.data.email,
      credentials: encryptSecret(JSON.stringify(tokens), requireConfig("TOKEN_ENCRYPTION_KEY")),
    };
  }

  async sync(account: StoredAccount, cursor: string | null): Promise<SyncPage> {
    const gmail = await this.client(account);
    if (!cursor || cursor.startsWith("backfill:")) {
      const pageToken = cursor?.slice("backfill:".length) || undefined;
      const page = await gmail.users.messages.list({
        userId: "me",
        maxResults: 100,
        pageToken,
        includeSpamTrash: true,
      });
      const messages: NormalizedMessage[] = [];
      const pending = [...(page.data.messages ?? [])];
      while (pending.length > 0) {
        const chunk = pending.splice(0, 10);
        const full = await Promise.all(
          chunk.flatMap((item) =>
            item.id
              ? [gmail.users.messages.get({ userId: "me", id: item.id, format: "full" })]
              : [],
          ),
        );
        messages.push(...full.map((item) => normalizeGmailMessage(item.data, account.email)));
      }
      if (page.data.nextPageToken) {
        return {
          messages,
          deletedProviderMessageIds: [],
          nextCursor: `backfill:${page.data.nextPageToken}`,
          backfillComplete: false,
        };
      }
      const profile = await gmail.users.getProfile({ userId: "me" });
      return {
        messages,
        deletedProviderMessageIds: [],
        nextCursor: `history:${profile.data.historyId ?? ""}`,
        backfillComplete: true,
      };
    }

    const startHistoryId = cursor.replace(/^history:/, "");
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    try {
      do {
        const page = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          pageToken,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        });
        latestHistoryId = page.data.historyId ?? latestHistoryId;
        for (const history of page.data.history ?? []) {
          for (const entry of history.messagesAdded ?? [])
            if (entry.message?.id) changed.add(entry.message.id);
          for (const entry of history.labelsAdded ?? [])
            if (entry.message?.id) changed.add(entry.message.id);
          for (const entry of history.labelsRemoved ?? [])
            if (entry.message?.id) changed.add(entry.message.id);
          for (const entry of history.messagesDeleted ?? [])
            if (entry.message?.id) deleted.add(entry.message.id);
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      // Gmail expires history IDs. Its documented recovery is a fresh full synchronization.
      if ((error as { code?: number }).code === 404) return this.sync(account, null);
      throw error;
    }

    const messages: NormalizedMessage[] = [];
    for (const id of changed) {
      if (deleted.has(id)) continue;
      try {
        const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        messages.push(normalizeGmailMessage(full.data, account.email));
      } catch (error) {
        if ((error as { code?: number }).code === 404) deleted.add(id);
        else throw error;
      }
    }
    return {
      messages,
      deletedProviderMessageIds: [...deleted],
      nextCursor: `history:${latestHistoryId}`,
      backfillComplete: true,
    };
  }

  async applyAction(
    account: StoredAccount,
    providerMessageId: string,
    action: ProviderAction,
  ): Promise<void> {
    const gmail = await this.client(account);
    const labels: Record<ProviderAction, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
      mark_read: { removeLabelIds: ["UNREAD"] },
      mark_unread: { addLabelIds: ["UNREAD"] },
      flag: { addLabelIds: ["STARRED"] },
      unflag: { removeLabelIds: ["STARRED"] },
      archive: { removeLabelIds: ["INBOX"] },
      delete: { addLabelIds: ["TRASH"] },
    };
    await gmail.users.messages.modify({
      userId: "me",
      id: providerMessageId,
      requestBody: labels[action],
    });
  }

  async send(
    account: StoredAccount,
    message: OutgoingMessage,
    beforeSend?: () => Promise<void>,
  ): Promise<string> {
    const gmail = await this.client(account);
    const composer = new MailComposer({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.body,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.contentBase64, "base64"),
      })),
    });
    const raw = await composer.compile().build();
    await beforeSend?.();
    const result = await gmail.users.messages.send(
      {
        userId: "me",
        requestBody: { raw: raw.toString("base64url") },
      },
      { retry: false },
    );
    if (!result.data.id) throw new Error("Gmail did not return a sent message id");
    return result.data.id;
  }

  async fetchAttachment(account: StoredAccount, providerMessageId: string, attachmentId: string) {
    const gmail = await this.client(account);
    const [attachment, message] = await Promise.all([
      gmail.users.messages.attachments.get({
        userId: "me",
        messageId: providerMessageId,
        id: attachmentId,
      }),
      gmail.users.messages.get({ userId: "me", id: providerMessageId, format: "full" }),
    ]);
    const part = walkParts(message.data.payload).find(
      (item) => item.body?.attachmentId === attachmentId,
    );
    if (!attachment.data.data) throw new Error("Gmail attachment had no bytes");
    return {
      bytes: Buffer.from(attachment.data.data, "base64url"),
      contentType: part?.mimeType ?? "application/octet-stream",
      filename: part?.filename ?? "attachment",
    };
  }
}
