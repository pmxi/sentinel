import { randomUUID } from "node:crypto";
import type {
  Account,
  Draft,
  DraftInput,
  HealthResponse,
  MessageDetail,
  MessageListResponse,
  MessageSummary,
  Provider,
  SearchResponse,
  Tier,
} from "@sent/shared";
import type { PoolClient, QueryResultRow } from "pg";
import type { NormalizedMessage, StoredAccount } from "../providers/types.ts";
import { getPool } from "./client.ts";

type AccountRow = QueryResultRow & {
  id: string;
  provider: Provider;
  email: string;
  display_name: string;
  encrypted_credentials: string;
  status: Account["status"];
  last_synced_at: Date | null;
};

type MessageRow = QueryResultRow & {
  id: string;
  thread_id: string;
  account_id: string;
  provider: Provider;
  account_email: string;
  account_display_name: string;
  subject: string;
  from_addresses: MessageSummary["from"];
  to_addresses?: MessageDetail["to"];
  cc_addresses?: MessageDetail["cc"];
  bcc_addresses?: MessageDetail["bcc"];
  snippet: string;
  text_body?: string;
  html_body?: string | null;
  plain_text?: string | null;
  sent_at?: Date | null;
  received_at: Date;
  read: boolean;
  thread_read?: boolean;
  flagged: boolean;
  direction: "inbound" | "outbound";
  model_tier: Tier | null;
  manual_tier: Tier | null;
  reasoning: string | null;
  attachments: MessageDetail["attachments"];
  internet_message_id?: string | null;
  sync_pending: boolean;
};

const MESSAGE_SELECT = `
  m.id, m.thread_id, m.account_id, a.provider, a.email account_email, a.display_name account_display_name,
  m.subject, m.from_addresses, m.snippet, m.received_at, m.read, m.flagged, m.direction, m.attachments,
  c.model_tier, c.manual_tier, c.reasoning, c.plain_text,
  exists(select 1 from mutation_outbox o where o.message_id=m.id and o.status in ('pending','processing')) sync_pending`;

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
  };
}

function mapSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    account: {
      id: row.account_id,
      provider: row.provider,
      email: row.account_email,
      displayName: row.account_display_name,
    },
    subject: row.subject,
    from: row.from_addresses,
    snippet: row.snippet,
    receivedAt: row.received_at.toISOString(),
    read: row.thread_read ?? row.read,
    flagged: row.flagged,
    direction: row.direction,
    tier: row.manual_tier ?? row.model_tier,
    modelTier: row.model_tier,
    reasoning: row.reasoning,
    attachmentCount: row.attachments.length,
    syncPending: row.sync_pending,
  };
}

function mapDetail(row: MessageRow): MessageDetail {
  return {
    ...mapSummary(row),
    to: row.to_addresses ?? [],
    cc: row.cc_addresses ?? [],
    bcc: row.bcc_addresses ?? [],
    sentAt: row.sent_at?.toISOString() ?? null,
    textBody: row.text_body ?? "",
    htmlBody: row.html_body ?? null,
    plainText: row.plain_text ?? null,
    attachments: row.attachments,
    internetMessageId: row.internet_message_id ?? null,
  };
}

function encodeCursor(receivedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ receivedAt: receivedAt.toISOString(), id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { receivedAt: Date; id: string } {
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    receivedAt: string;
    id: string;
  };
  return { receivedAt: new Date(value.receivedAt), id: value.id };
}

async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export class MailRepository {
  async listAccounts(): Promise<Account[]> {
    const result = await getPool().query<AccountRow>("select * from accounts order by created_at");
    return result.rows.map(mapAccount);
  }

  async listStoredAccounts(): Promise<StoredAccount[]> {
    const result = await getPool().query<AccountRow>(
      "select * from accounts where status != 'needs_reauth' order by created_at",
    );
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      email: row.email,
      displayName: row.display_name,
      encryptedCredentials: row.encrypted_credentials,
    }));
  }

  async getStoredAccount(id: string): Promise<StoredAccount | null> {
    const row = (await getPool().query<AccountRow>("select * from accounts where id=$1", [id]))
      .rows[0];
    return row
      ? {
          id: row.id,
          provider: row.provider,
          email: row.email,
          displayName: row.display_name,
          encryptedCredentials: row.encrypted_credentials,
        }
      : null;
  }

  async upsertAccount(input: {
    provider: Provider;
    email: string;
    displayName: string;
    encryptedCredentials: string;
  }): Promise<string> {
    const result = await getPool().query<{ id: string }>(
      `
      insert into accounts(provider,email,display_name,encrypted_credentials,status,updated_at)
      values($1,$2,$3,$4,'active',now())
      on conflict(provider,email) do update set display_name=excluded.display_name,
        encrypted_credentials=excluded.encrypted_credentials,status='active',last_error=null,updated_at=now()
      returning id`,
      [input.provider, input.email.toLowerCase(), input.displayName, input.encryptedCredentials],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Failed to upsert account");
    await getPool().query(
      "insert into sync_cursors(account_id) values($1) on conflict do nothing",
      [id],
    );
    return id;
  }

  async updateCredentials(accountId: string, encryptedCredentials: string): Promise<void> {
    await getPool().query(
      "update accounts set encrypted_credentials=$2, updated_at=now() where id=$1",
      [accountId, encryptedCredentials],
    );
  }

  async getSyncCursor(
    accountId: string,
  ): Promise<{ cursor: string | null; backfillComplete: boolean }> {
    const row = (
      await getPool().query<{ cursor: string | null; backfill_complete: boolean }>(
        "select cursor,backfill_complete from sync_cursors where account_id=$1",
        [accountId],
      )
    ).rows[0];
    return { cursor: row?.cursor ?? null, backfillComplete: row?.backfill_complete ?? false };
  }

  async finishSync(
    accountId: string,
    cursor: string | null,
    backfillComplete: boolean,
  ): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `insert into sync_cursors(account_id,cursor,backfill_complete,last_successful_at,updated_at)
        values($1,$2,$3,now(),now()) on conflict(account_id) do update set cursor=excluded.cursor,
        backfill_complete=excluded.backfill_complete,last_successful_at=now(),updated_at=now()`,
        [accountId, cursor, backfillComplete],
      );
      await client.query(
        "update accounts set status='active',last_synced_at=now(),last_error=null,updated_at=now() where id=$1",
        [accountId],
      );
    });
  }

  async failSync(accountId: string, error: string, needsReauth = false): Promise<void> {
    await getPool().query(
      "update accounts set status=$2,last_error=$3,updated_at=now() where id=$1",
      [accountId, needsReauth ? "needs_reauth" : "error", error.slice(0, 2000)],
    );
  }

  async upsertMessage(
    accountId: string,
    message: NormalizedMessage,
  ): Promise<{ id: string; changed: boolean }> {
    return transaction(async (client) => {
      const existing = (
        await client.query<{ id: string; subject: string; text_body: string }>(
          "select id,subject,text_body from messages where account_id=$1 and provider_message_id=$2",
          [accountId, message.providerMessageId],
        )
      ).rows[0];
      const thread = await client.query<{ id: string }>(
        `
        insert into threads(account_id,provider_thread_id,subject,last_message_at)
        values($1,$2,$3,$4) on conflict(account_id,provider_thread_id) do update set
          subject=excluded.subject,last_message_at=greatest(threads.last_message_at,excluded.last_message_at),updated_at=now()
        returning id`,
        [accountId, message.providerThreadId, message.subject, message.receivedAt],
      );
      const threadId = thread.rows[0]?.id;
      if (!threadId) throw new Error("Failed to upsert thread");
      const saved = await client.query<{ id: string }>(
        `
        insert into messages(account_id,thread_id,provider_message_id,internet_message_id,subject,from_addresses,to_addresses,
          cc_addresses,bcc_addresses,sent_at,received_at,snippet,text_body,html_body,headers,attachments,direction,read,
          flagged,archived,deleted,tombstone,native_state,provider_updated_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now())
        on conflict(account_id,provider_message_id) do update set thread_id=excluded.thread_id,
          internet_message_id=excluded.internet_message_id,subject=excluded.subject,from_addresses=excluded.from_addresses,
          to_addresses=excluded.to_addresses,cc_addresses=excluded.cc_addresses,bcc_addresses=excluded.bcc_addresses,
          sent_at=excluded.sent_at,received_at=excluded.received_at,snippet=excluded.snippet,text_body=excluded.text_body,
          html_body=excluded.html_body,headers=excluded.headers,attachments=excluded.attachments,direction=excluded.direction,
          read=excluded.read,flagged=excluded.flagged,archived=excluded.archived,deleted=excluded.deleted,
          tombstone=excluded.tombstone,native_state=excluded.native_state,provider_updated_at=excluded.provider_updated_at,updated_at=now()
        returning id`,
        [
          accountId,
          threadId,
          message.providerMessageId,
          message.internetMessageId,
          message.subject,
          JSON.stringify(message.from),
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          JSON.stringify(message.bcc),
          message.sentAt,
          message.receivedAt,
          message.snippet,
          message.textBody,
          message.htmlBody,
          JSON.stringify(message.headers),
          JSON.stringify(message.attachments),
          message.direction,
          message.read,
          message.flagged,
          message.archived,
          message.deleted,
          message.tombstone ?? false,
          JSON.stringify(message.nativeState),
          message.providerUpdatedAt,
        ],
      );
      const messageId = saved.rows[0]?.id;
      if (!messageId) throw new Error("Failed to upsert message");
      await client.query("delete from message_containers where message_id=$1", [messageId]);
      for (const container of message.containers) {
        await client.query(
          `insert into provider_containers(account_id,provider_id,name,kind) values($1,$2,$3,$4)
          on conflict(account_id,provider_id) do update set name=excluded.name,kind=excluded.kind`,
          [accountId, container.id, container.name, container.kind],
        );
        await client.query(
          "insert into message_containers(message_id,account_id,provider_id) values($1,$2,$3) on conflict do nothing",
          [messageId, accountId, container.id],
        );
      }
      return {
        id: messageId,
        changed:
          !existing ||
          existing.subject !== message.subject ||
          existing.text_body !== message.textBody,
      };
    });
  }

  async tombstoneMessages(accountId: string, providerMessageIds: string[]): Promise<void> {
    if (providerMessageIds.length === 0) return;
    await getPool().query(
      "update messages set tombstone=true,deleted=true,updated_at=now() where account_id=$1 and provider_message_id=any($2::text[])",
      [accountId, providerMessageIds],
    );
  }

  async listMessages(input: {
    view: string;
    accountId?: string;
    cursor?: string;
    limit: number;
  }): Promise<MessageListResponse> {
    const params: unknown[] = [];
    const conditions = ["not m.tombstone"];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.accountId) conditions.push(`m.account_id=${push(input.accountId)}`);
    const effectiveTier = "coalesce(c.manual_tier,c.model_tier)";
    if (["l1", "l2", "l3", "unclassified"].includes(input.view))
      conditions.push("not m.archived", "m.direction='inbound'");
    if (input.view === "l1") conditions.push(`(${effectiveTier}=1 or c.message_id is null)`);
    else if (input.view === "l2") conditions.push(`${effectiveTier}=2`);
    else if (input.view === "l3") conditions.push(`${effectiveTier}=3`);
    else if (input.view === "unclassified") conditions.push("c.message_id is null");
    else if (input.view === "sent") conditions.push("m.direction='outbound' and not m.deleted");
    else if (input.view === "trash") conditions.push("m.deleted");
    else conditions.push("not m.deleted");
    if (!["trash"].includes(input.view)) conditions.push("not m.deleted");
    let cursorCondition = "";
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      cursorCondition = `and (received_at,id)<(${push(cursor.receivedAt)},${push(cursor.id)}::uuid)`;
    }
    const limitParameter = push(input.limit + 1);
    const result = await getPool().query<MessageRow>(
      `with conversations as (
      select ${MESSAGE_SELECT},
        row_number() over (partition by m.thread_id order by m.received_at desc,m.id desc) as thread_rank,
        bool_and(m.read) over (partition by m.thread_id) as thread_read
      from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id
      where ${conditions.join(" and ")})
      select * from conversations where thread_rank=1 ${cursorCondition}
      order by received_at desc,id desc limit ${limitParameter}`,
      params,
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      messages: rows.map(mapSummary),
      nextCursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null,
    };
  }

  async getMessage(id: string): Promise<MessageDetail | null> {
    const row = (
      await getPool().query<MessageRow>(
        `select ${MESSAGE_SELECT},m.to_addresses,m.cc_addresses,m.bcc_addresses,
      m.sent_at,m.text_body,m.html_body,m.internet_message_id
      from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id
      where m.id=$1 and not m.tombstone`,
        [id],
      )
    ).rows[0];
    return row ? mapDetail(row) : null;
  }

  async getThread(threadId: string): Promise<MessageDetail[]> {
    const rows = (
      await getPool().query<MessageRow>(
        `select ${MESSAGE_SELECT},m.to_addresses,m.cc_addresses,m.bcc_addresses,
      m.sent_at,m.text_body,m.html_body,m.internet_message_id
      from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id
      where m.thread_id=$1 and not m.tombstone order by m.received_at`,
        [threadId],
      )
    ).rows;
    return rows.map(mapDetail);
  }

  async setTierOverride(messageId: string, tier: Tier | null): Promise<void> {
    const result = await getPool().query(
      "update classifications set manual_tier=$2,updated_at=now() where message_id=$1",
      [messageId, tier],
    );
    if (result.rowCount === 0 && tier !== null) {
      await getPool().query(
        `insert into classifications(message_id,model_tier,reasoning,manual_tier,model,prompt_version)
        values($1,1,'Manual classification before model result',$2,'manual','manual')`,
        [messageId, tier],
      );
    }
  }

  async enqueueAction(messageId: string, action: string): Promise<string> {
    return transaction(async (client) => {
      const message = (
        await client.query<{ account_id: string }>(
          "select account_id from messages where id=$1 for update",
          [messageId],
        )
      ).rows[0];
      if (!message) throw new Error("Message not found");
      const id = randomUUID();
      await client.query(
        `insert into mutation_outbox(id,idempotency_key,account_id,message_id,action)
        values($1,$2,$3,$4,$5)`,
        [id, id, message.account_id, messageId, action],
      );
      const updates: Record<string, string> = {
        mark_read: "read=true",
        mark_unread: "read=false",
        flag: "flagged=true",
        unflag: "flagged=false",
        archive: "archived=true",
        delete: "deleted=true",
      };
      const update = updates[action];
      if (!update) throw new Error("Unsupported message action");
      await client.query(`update messages set ${update},updated_at=now() where id=$1`, [messageId]);
      return id;
    });
  }

  async createOrUpdateDraft(input: DraftInput): Promise<Draft> {
    const values = [
      input.accountId,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      input.body,
      input.replyToMessageId,
      input.forwardOfMessageId,
    ];
    const result = input.id
      ? await getPool().query(
          `update drafts set account_id=$2,to_addresses=$3,cc_addresses=$4,bcc_addresses=$5,
          subject=$6,body=$7,reply_to_message_id=$8,forward_of_message_id=$9,updated_at=now() where id=$1 returning *`,
          [input.id, ...values],
        )
      : await getPool().query(
          `insert into drafts(account_id,to_addresses,cc_addresses,bcc_addresses,subject,body,
          reply_to_message_id,forward_of_message_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          values,
        );
    const row = result.rows[0];
    if (!row) throw new Error("Draft not found");
    return this.mapDraft(row);
  }

  async listDrafts(): Promise<Draft[]> {
    return (await getPool().query("select * from drafts order by updated_at desc")).rows.map(
      (row) => this.mapDraft(row),
    );
  }

  async getDraft(id: string): Promise<Draft | null> {
    const row = (await getPool().query("select * from drafts where id=$1", [id])).rows[0];
    return row ? this.mapDraft(row) : null;
  }

  async deleteDraft(id: string): Promise<void> {
    await getPool().query("delete from drafts where id=$1", [id]);
  }

  async enqueueSend(
    draftId: string,
    attachments: Array<{ filename: string; contentType: string; contentBase64: string }>,
  ): Promise<string> {
    return transaction(async (client) => {
      const draft = (await client.query("select * from drafts where id=$1 for update", [draftId]))
        .rows[0];
      if (!draft) throw new Error("Draft not found");
      const id = randomUUID();
      await client.query(
        `insert into mutation_outbox(id,idempotency_key,account_id,action,payload)
        values($1,$2,$3,'send',$4)`,
        [id, id, draft.account_id, JSON.stringify({ draft: this.mapDraft(draft), attachments })],
      );
      await client.query("delete from drafts where id=$1", [draftId]);
      return id;
    });
  }

  private mapDraft(row: Record<string, unknown>): Draft {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      to: row.to_addresses as Draft["to"],
      cc: row.cc_addresses as Draft["cc"],
      bcc: row.bcc_addresses as Draft["bcc"],
      subject: String(row.subject),
      body: String(row.body),
      replyToMessageId: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
      forwardOfMessageId: row.forward_of_message_id ? String(row.forward_of_message_id) : null,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  async claimMutations(limit = 20): Promise<
    Array<{
      id: string;
      accountId: string;
      messageId: string | null;
      action: string;
      payload: Record<string, unknown>;
    }>
  > {
    return transaction(async (client) => {
      const rows = (
        await client.query(
          `select id,account_id,message_id,action,payload from mutation_outbox
        where status in ('pending','processing') and next_attempt_at<=now() order by created_at for update skip locked limit $1`,
          [limit],
        )
      ).rows;
      if (rows.length)
        await client.query(
          "update mutation_outbox set status='processing',attempts=attempts+1,next_attempt_at=now()+interval '5 minutes' where id=any($1::uuid[])",
          [rows.map((row) => row.id)],
        );
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        messageId: row.message_id,
        action: row.action,
        payload: row.payload,
      }));
    });
  }

  async completeMutation(id: string): Promise<void> {
    await getPool().query(
      "update mutation_outbox set status='complete',completed_at=now(),last_error=null where id=$1",
      [id],
    );
  }

  async recordSendAttempt(id: string): Promise<void> {
    const result = await getPool().query(
      `update mutation_outbox set payload=payload || jsonb_build_object('sendAttemptedAt',now())
       where id=$1 and action='send' and status='processing' and not (payload ? 'sendAttemptedAt')
       returning id`,
      [id],
    );
    if (result.rowCount !== 1)
      throw new Error("This send has already been attempted; automatic resend blocked");
  }

  async failMutation(id: string, error: string): Promise<void> {
    await getPool().query(
      `update mutation_outbox set status=case when attempts>=8 or payload ? 'sendAttemptedAt' then 'failed'::mutation_status else 'pending'::mutation_status end,
      next_attempt_at=now() + (least(3600,power(2,attempts)::int) * interval '1 second'),
      last_error=case when payload ? 'sendAttemptedAt'
        then 'Delivery may have succeeded. Automatic resend blocked; check Sent before retrying. ' || $2
        else $2 end where id=$1`,
      [id, error.slice(0, 2000)],
    );
  }

  async getProviderMessageReference(
    messageId: string,
  ): Promise<{ providerMessageId: string; accountId: string } | null> {
    const row = (
      await getPool().query<{ provider_message_id: string; account_id: string }>(
        "select provider_message_id,account_id from messages where id=$1",
        [messageId],
      )
    ).rows[0];
    return row ? { providerMessageId: row.provider_message_id, accountId: row.account_id } : null;
  }

  async getAnalysisMessage(messageId: string): Promise<{
    id: string;
    subject: string;
    from: MessageDetail["from"];
    to: MessageDetail["to"];
    cc: MessageDetail["cc"];
    sentAt: Date | null;
    receivedAt: Date;
    textBody: string;
  } | null> {
    const row = (
      await getPool().query(
        "select id,subject,from_addresses,to_addresses,cc_addresses,sent_at,received_at,text_body from messages where id=$1 and not tombstone",
        [messageId],
      )
    ).rows[0];
    return row
      ? {
          id: row.id,
          subject: row.subject,
          from: row.from_addresses,
          to: row.to_addresses,
          cc: row.cc_addresses,
          sentAt: row.sent_at,
          receivedAt: row.received_at,
          textBody: row.text_body,
        }
      : null;
  }

  async saveClassification(
    messageId: string,
    input: {
      tier: Tier;
      reasoning: string;
      plainText: string;
      model: string;
      promptVersion: string;
    },
  ): Promise<void> {
    await transaction(async (client) => {
      await client.query(
        `insert into classifications(message_id,model_tier,reasoning,plain_text,model,prompt_version,classified_at,updated_at)
        values($1,$2,$3,$4,$5,$6,now(),now()) on conflict(message_id) do update set model_tier=excluded.model_tier,
        reasoning=excluded.reasoning,plain_text=excluded.plain_text,model=excluded.model,
        prompt_version=excluded.prompt_version,classified_at=now(),updated_at=now()`,
        [
          messageId,
          input.tier,
          input.reasoning,
          input.plainText.trim(),
          input.model,
          input.promptVersion,
        ],
      );
      await client.query("delete from classification_failures where message_id=$1", [messageId]);
    });
  }

  async saveClassificationFailure(messageId: string, error: string): Promise<void> {
    await getPool().query(
      `insert into classification_failures(message_id,last_error) values($1,$2)
      on conflict(message_id) do update set attempts=classification_failures.attempts+1,last_error=excluded.last_error,updated_at=now()`,
      [messageId, error.slice(0, 2000)],
    );
  }

  async saveEmbedding(
    messageId: string,
    embedding: number[],
    model: string,
    hash: string,
  ): Promise<void> {
    await getPool().query(
      `insert into embeddings(message_id,embedding,model,content_hash) values($1,$2::vector,$3,$4)
      on conflict(message_id) do update set embedding=excluded.embedding,model=excluded.model,content_hash=excluded.content_hash,created_at=now()`,
      [messageId, `[${embedding.join(",")}]`, model, hash],
    );
  }

  async newestUnclassified(limit: number, accountEmail?: string): Promise<string[]> {
    return (
      await getPool().query<{ id: string }>(
        `select m.id from messages m join accounts a on a.id=m.account_id
        left join classifications c on c.message_id=m.id
      where c.message_id is null and not m.tombstone and m.direction='inbound'
      and ($2::text is null or lower(a.email)=lower($2))
      order by m.received_at desc limit $1`,
        [limit, accountEmail ?? null],
      )
    ).rows.map((row) => row.id);
  }

  async newestInbound(limit: number, accountEmail?: string): Promise<string[]> {
    return (
      await getPool().query<{ id: string }>(
        `select m.id from messages m join accounts a on a.id=m.account_id
        where not m.tombstone and m.direction='inbound'
        and ($2::text is null or lower(a.email)=lower($2))
        order by m.received_at desc,m.id desc limit $1`,
        [limit, accountEmail ?? null],
      )
    ).rows.map((row) => row.id);
  }

  async unembedded(limit: number, afterId?: string): Promise<string[]> {
    return (
      await getPool().query<{ id: string }>(
        `select m.id from messages m left join embeddings e on e.message_id=m.id
      where e.message_id is null and not m.tombstone and ($2::uuid is null or m.id>$2::uuid) order by m.id limit $1`,
        [limit, afterId ?? null],
      )
    ).rows.map((row) => row.id);
  }

  async search(input: {
    q: string;
    embedding?: number[];
    accountId?: string;
    tier?: Tier;
    after?: Date;
    before?: Date;
    hasAttachment?: boolean;
    limit: number;
  }): Promise<SearchResponse> {
    const params: unknown[] = [input.q];
    const conditions = ["not m.tombstone", "not m.deleted"];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.accountId) conditions.push(`m.account_id=${add(input.accountId)}`);
    if (input.tier) conditions.push(`coalesce(c.manual_tier,c.model_tier)=${add(input.tier)}`);
    if (input.after) conditions.push(`m.received_at>=${add(input.after)}`);
    if (input.before) conditions.push(`m.received_at<${add(input.before)}`);
    if (input.hasAttachment !== undefined)
      conditions.push(
        input.hasAttachment
          ? "jsonb_array_length(m.attachments)>0"
          : "jsonb_array_length(m.attachments)=0",
      );
    const where = conditions.join(" and ");
    let sql: string;
    if (input.embedding) {
      const embedding = add(`[${input.embedding.join(",")}]`);
      const limit = add(input.limit);
      sql = `with lexical as (
          select m.id,row_number() over(order by ts_rank_cd(m.search_document,websearch_to_tsquery('english',$1)) desc) rank
          from messages m left join classifications c on c.message_id=m.id where ${where}
            and m.search_document @@ websearch_to_tsquery('english',$1) limit 200
        ), semantic as (
          select m.id,row_number() over(order by e.embedding <=> ${embedding}::vector) rank
          from messages m join embeddings e on e.message_id=m.id left join classifications c on c.message_id=m.id
          where ${where} order by e.embedding <=> ${embedding}::vector limit 200
        ), fused as (
          select id,sum(score) score from (
            select id,1.0/(60+rank) score from lexical union all select id,1.0/(60+rank) score from semantic
          ) scores group by id
        ) select ${MESSAGE_SELECT} from fused f join messages m on m.id=f.id join accounts a on a.id=m.account_id
          left join classifications c on c.message_id=m.id order by f.score desc,m.received_at desc limit ${limit}`;
    } else {
      const limit = add(input.limit);
      sql = `select ${MESSAGE_SELECT} from messages m join accounts a on a.id=m.account_id
        left join classifications c on c.message_id=m.id where ${where}
        and m.search_document @@ websearch_to_tsquery('english',$1)
        order by ts_rank_cd(m.search_document,websearch_to_tsquery('english',$1)) desc,m.received_at desc limit ${limit}`;
    }
    const rows = (await getPool().query<MessageRow>(sql, params)).rows;
    return { messages: rows.map(mapSummary), mode: input.embedding ? "hybrid" : "lexical" };
  }

  async heartbeat(name: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await getPool().query(
      `insert into worker_state(name,heartbeat_at,metadata) values($1,now(),$2)
      on conflict(name) do update set heartbeat_at=now(),metadata=excluded.metadata`,
      [name, JSON.stringify(metadata)],
    );
  }

  async health(): Promise<Omit<HealthResponse, "database">> {
    const result = await getPool().query<{
      worker_heartbeat: Date | null;
      failed_mutations: string;
      classification_failures: string;
      accounts: string;
      needs_reauth: string;
      oldest_successful_sync_at: Date | null;
      stale: string;
    }>(`select (select max(heartbeat_at) from worker_state) worker_heartbeat,
      (select count(*) from mutation_outbox where status='failed') failed_mutations,
      (select count(*) from classification_failures) classification_failures,
      count(*) accounts,
      count(*) filter (where status='needs_reauth') needs_reauth,
      min(last_synced_at) oldest_successful_sync_at,
      count(*) filter (where last_synced_at is null or last_synced_at < now() - interval '3 minutes') stale
      from accounts`);
    const row = result.rows[0];
    const heartbeat = row?.worker_heartbeat ?? null;
    const failedMutations = Number(row?.failed_mutations ?? 0);
    const needsReauth = Number(row?.needs_reauth ?? 0);
    const stale = Number(row?.stale ?? 0);
    const fresh = needsReauth === 0 && stale === 0;
    const degraded =
      !heartbeat || Date.now() - heartbeat.getTime() > 180_000 || failedMutations > 0 || !fresh;
    return {
      status: degraded ? "degraded" : "ok",
      workerHeartbeat: heartbeat?.toISOString() ?? null,
      failedMutations,
      classificationFailures: Number(row?.classification_failures ?? 0),
      sync: {
        accounts: Number(row?.accounts ?? 0),
        needsReauth,
        oldestSuccessfulSyncAt: row?.oldest_successful_sync_at?.toISOString() ?? null,
        stale,
        fresh,
      },
    };
  }
}
