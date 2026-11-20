import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;
export const UNDO_WINDOW_MS = 5_000;

export type MutationReceipt = { mutationId: string; undoUntil?: string | null };

export const ProviderSchema = z.enum(["gmail", "microsoft"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof TierSchema>;

export const MailAddressSchema = z.object({
  name: z.string().default(""),
  address: z.string().email(),
});
export type MailAddress = z.infer<typeof MailAddressSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  inline: z.boolean().default(false),
  contentId: z.string().nullable().default(null),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AccountSchema = z.object({
  id: z.string().uuid(),
  provider: ProviderSchema,
  email: z.string().email(),
  displayName: z.string(),
  status: z.enum(["active", "needs_reauth", "syncing", "error"]),
  lastSyncedAt: z.string().nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const MessageSummarySchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  account: AccountSchema.pick({ id: true, provider: true, email: true, displayName: true }),
  subject: z.string(),
  from: z.array(MailAddressSchema),
  snippet: z.string(),
  receivedAt: z.string(),
  read: z.boolean(),
  flagged: z.boolean(),
  direction: z.enum(["inbound", "outbound"]),
  tier: TierSchema.nullable(),
  modelTier: TierSchema.nullable(),
  reasoning: z.string().nullable(),
  aiSummary: z.string().nullable().default(null),
  attachmentCount: z.number().int().nonnegative(),
  syncPending: z.boolean(),
});
export type MessageSummary = z.infer<typeof MessageSummarySchema>;

export const ConversationSummarySchema = MessageSummarySchema.extend({
  messageCount: z.number().int().positive(),
  unreadCount: z.number().int().nonnegative(),
  participants: z.array(MailAddressSchema),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const MessageDetailSchema = MessageSummarySchema.extend({
  to: z.array(MailAddressSchema),
  cc: z.array(MailAddressSchema),
  bcc: z.array(MailAddressSchema),
  sentAt: z.string().nullable(),
  textBody: z.string(),
  htmlBody: z.string().nullable(),
  plainText: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
  internetMessageId: z.string().nullable(),
});
export type MessageDetail = z.infer<typeof MessageDetailSchema>;

export const MessageListQuerySchema = z.object({
  view: z
    .enum(["inbox", "l1", "l2", "l3", "unclassified", "all", "sent", "trash"])
    .default("inbox"),
  accountId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  accountId: z.string().uuid().optional(),
  tier: TierSchema.optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  hasAttachment: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MessageActionSchema = z.object({
  action: z.enum(["mark_read", "mark_unread", "flag", "unflag", "archive", "delete"]),
  undoable: z.boolean().default(false),
});

export const ThreadActionSchema = MessageListQuerySchema.pick({
  view: true,
  accountId: true,
}).extend({
  action: z.enum(["archive", "delete"]),
  undoable: z.boolean().default(false),
});

export const TierOverrideSchema = z.object({ tier: TierSchema.nullable() });

export const DraftInputSchema = z.object({
  id: z.string().uuid().optional(),
  accountId: z.string().uuid(),
  to: z.array(MailAddressSchema).default([]),
  cc: z.array(MailAddressSchema).default([]),
  bcc: z.array(MailAddressSchema).default([]),
  subject: z.string().max(998).default(""),
  body: z.string().max(2_000_000).default(""),
  replyToMessageId: z.string().uuid().nullable().default(null),
  forwardOfMessageId: z.string().uuid().nullable().default(null),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

export const DraftSchema = DraftInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const LoginSchema = z.object({ password: z.string().min(1).max(1024) });

export const ApiErrorSchema = z.object({ error: z.string(), details: z.unknown().optional() });

export type MessageListResponse = {
  messages: ConversationSummary[];
  nextCursor: string | null;
};

export type SearchResponse = {
  messages: ConversationSummary[];
  mode: "hybrid" | "lexical";
};

export type HealthResponse = {
  status: "ok" | "degraded";
  database: boolean;
  workerHeartbeat: string | null;
  failedMutations: number;
  classificationFailures: number;
  sync: {
    accounts: number;
    needsReauth: number;
    oldestSuccessfulSyncAt: string | null;
    stale: number;
    fresh: boolean;
  };
};
