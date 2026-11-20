import type { Account, ConversationSummary, MessageDetail, Tier } from "@sent/shared";
import type { CachedMessage, MessagePatch } from "./api";

export type ReplicaRow = CachedMessage & {
  archived: boolean;
  deleted: boolean;
  classified: boolean;
  bodyVersion: string;
  bodyAvailable: boolean;
  sortReceivedAt: string;
};
export type ReplicaPage = {
  messages: ReplicaRow[];
  accounts: Account[];
  cursor: string;
  nextCursor: string | null;
};
export type ReplicaDelta = {
  upserts: ReplicaRow[];
  deletions: string[];
  accounts: Account[];
  cursor: string;
};
export type ReplicaChange = {
  id?: string;
  threadId?: string;
  action?: string;
  tier?: Tier | null;
  view?: string;
  accountId?: string;
  patch?: Partial<MessagePatch>;
};
export type ReplicaDetail = { message: MessageDetail; hasBody: boolean; packedBody?: Uint8Array };
export type ReplicaList = { messages: ConversationSummary[]; nextCursor: string | null };
export const REPLICA_SESSION_KEY = "sent:replica:session:v1";
export const MAX_BODY_BYTES = 262144;
export const MAX_BODY_CACHE_BYTES = 32 * 1024 * 1024;
