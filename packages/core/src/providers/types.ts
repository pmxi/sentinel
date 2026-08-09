import type { Attachment, MailAddress, Provider } from "@sent/shared";

export type StoredAccount = {
  id: string;
  provider: Provider;
  email: string;
  displayName: string;
  encryptedCredentials: string;
};

export type NormalizedMessage = {
  providerMessageId: string;
  providerThreadId: string;
  internetMessageId: string | null;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  sentAt: Date | null;
  receivedAt: Date;
  snippet: string;
  textBody: string;
  htmlBody: string | null;
  headers: Record<string, string>;
  attachments: Attachment[];
  direction: "inbound" | "outbound";
  read: boolean;
  flagged: boolean;
  archived: boolean;
  deleted: boolean;
  tombstone?: boolean;
  containers: Array<{ id: string; name: string; kind: string }>;
  nativeState: Record<string, unknown>;
  providerUpdatedAt: Date | null;
};

export type SyncPage = {
  messages: NormalizedMessage[];
  deletedProviderMessageIds: string[];
  nextCursor: string | null;
  backfillComplete: boolean;
};

export type OutgoingAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
};

export type OutgoingMessage = {
  from: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  replyToProviderMessageId: string | null;
  forwardOfProviderMessageId: string | null;
  references: string[];
  attachments: OutgoingAttachment[];
};

export type ProviderAction = "mark_read" | "mark_unread" | "flag" | "unflag" | "archive" | "delete";

export interface MailProvider {
  readonly provider: Provider;
  getAuthorizationUrl(state: string): Promise<string>;
  exchangeAuthorizationCode(code: string): Promise<{
    email: string;
    displayName: string;
    credentials: string;
  }>;
  sync(account: StoredAccount, cursor: string | null): Promise<SyncPage>;
  applyAction(
    account: StoredAccount,
    providerMessageId: string,
    action: ProviderAction,
  ): Promise<void>;
  send(account: StoredAccount, message: OutgoingMessage): Promise<string>;
  fetchAttachment(
    account: StoredAccount,
    providerMessageId: string,
    attachmentId: string,
  ): Promise<{
    bytes: Buffer;
    contentType: string;
    filename: string;
  }>;
}
