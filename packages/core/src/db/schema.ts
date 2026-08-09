import type { Attachment, MailAddress, Provider, Tier } from "@sent/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const providerEnum = pgEnum("provider", ["gmail", "microsoft"]);
export const accountStatusEnum = pgEnum("account_status", [
  "active",
  "needs_reauth",
  "syncing",
  "error",
]);
export const directionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
export const mutationStatusEnum = pgEnum("mutation_status", [
  "pending",
  "processing",
  "complete",
  "failed",
]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").$type<Provider>().notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    encryptedCredentials: text("encrypted_credentials").notNull(),
    status: accountStatusEnum("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("accounts_provider_email_idx").on(table.provider, table.email)],
);

export const syncCursors = pgTable("sync_cursors", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  cursor: text("cursor"),
  backfillComplete: boolean("backfill_complete").notNull().default(false),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("threads_provider_id_idx").on(table.accountId, table.providerThreadId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    subject: text("subject").notNull().default(""),
    from: jsonb("from_addresses").$type<MailAddress[]>().notNull().default([]),
    to: jsonb("to_addresses").$type<MailAddress[]>().notNull().default([]),
    cc: jsonb("cc_addresses").$type<MailAddress[]>().notNull().default([]),
    bcc: jsonb("bcc_addresses").$type<MailAddress[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    snippet: text("snippet").notNull().default(""),
    textBody: text("text_body").notNull().default(""),
    htmlBody: text("html_body"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
    direction: directionEnum("direction").notNull(),
    read: boolean("read").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    deleted: boolean("deleted").notNull().default(false),
    tombstone: boolean("tombstone").notNull().default(false),
    nativeState: jsonb("native_state").$type<Record<string, unknown>>().notNull().default({}),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_provider_id_idx").on(table.accountId, table.providerMessageId),
    index("messages_thread_idx").on(table.threadId, table.receivedAt),
    index("messages_received_idx").on(table.receivedAt),
  ],
);

export const providerContainers = pgTable(
  "provider_containers",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.providerId] })],
);

export const messageContainers = pgTable(
  "message_containers",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.providerId] })],
);

export const classifications = pgTable("classifications", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  modelTier: integer("model_tier").$type<Tier>().notNull(),
  reasoning: text("reasoning").notNull(),
  manualTier: integer("manual_tier").$type<Tier>(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const classificationFailures = pgTable("classification_failures", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const embeddings = pgTable("embeddings", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 3072 }).notNull(),
  model: text("model").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  to: jsonb("to_addresses").$type<MailAddress[]>().notNull().default([]),
  cc: jsonb("cc_addresses").$type<MailAddress[]>().notNull().default([]),
  bcc: jsonb("bcc_addresses").$type<MailAddress[]>().notNull().default([]),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  replyToMessageId: uuid("reply_to_message_id").references(() => messages.id, {
    onDelete: "set null",
  }),
  forwardOfMessageId: uuid("forward_of_message_id").references(() => messages.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mutationOutbox = pgTable(
  "mutation_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: mutationStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mutation_outbox_idempotency_idx").on(table.idempotencyKey),
    index("mutation_outbox_pending_idx").on(table.status, table.nextAttemptAt),
  ],
);

export const workerState = pgTable("worker_state", {
  name: text("name").primaryKey(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

export const searchDocumentSql = sql`setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_addresses::text, '') || ' ' || coalesce(to_addresses::text, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(text_body, '')), 'B')`;
