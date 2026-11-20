import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "../src/config.ts";
import { closeDb, getPool } from "../src/db/client.ts";
import { MailRepository } from "../src/db/repository.ts";
import type { NormalizedMessage } from "../src/providers/types.ts";

const databaseUrl = process.env.SENT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("mail views and send checkpoints in PostgreSQL", () => {
  const repository = new MailRepository();
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/sent_test_")) {
      throw new Error("Use an isolated database named sent_test_* for integration tests");
    }
    vi.stubEnv("DATABASE_URL", databaseUrl);
    resetEnvForTests();
    const schema = await readFile(
      new URL("../src/db/migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    // These tests exercise ordinary PostgreSQL queries, not vector search.
    await getPool().query(
      schema
        .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
        .replace("vector(3072)", "real[]"),
    );
    const summaryMigration = await readFile(
      new URL("../src/db/migrations/0003_ai_summary.sql", import.meta.url),
      "utf8",
    );
    await getPool().query(summaryMigration);
    await getPool().query(summaryMigration);
  });
  beforeEach(async () => {
    await getPool().query("truncate accounts cascade");
    for (const id of [accountId, otherAccountId]) {
      await getPool().query(
        "insert into accounts(id,provider,email,encrypted_credentials) values($1,'microsoft',$2,'test')",
        [id, `${id}@example.com`],
      );
    }
  });
  afterAll(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  async function message(
    thread: string,
    hour: number,
    overrides: Partial<NormalizedMessage> = {},
    owner = accountId,
  ) {
    return repository.upsertMessage(owner, {
      providerMessageId: randomUUID(),
      providerThreadId: thread,
      internetMessageId: null,
      subject: thread,
      from: [{ name: "Sender", address: "sender@example.com" }],
      to: [],
      cc: [],
      bcc: [],
      sentAt: new Date(Date.UTC(2026, 8, 22, hour)),
      receivedAt: new Date(Date.UTC(2026, 8, 22, hour)),
      snippet: "Test",
      textBody: "Test",
      htmlBody: null,
      headers: {},
      attachments: [],
      direction: "inbound",
      read: true,
      flagged: false,
      archived: false,
      deleted: false,
      tombstone: false,
      containers: [],
      nativeState: {},
      providerUpdatedAt: null,
      ...overrides,
    });
  }

  it.each(["archive", "delete"])("undoes %s before a worker can claim it", async (action) => {
    const saved = await message("undo", 8);
    const until = new Date(Date.now() + 5_000).toISOString();
    const id = await repository.enqueueAction(saved.id, action, until);
    expect(await repository.claimMutations()).toEqual([]);
    const column = action === "archive" ? "archived" : "deleted";
    expect(
      (await getPool().query(`select ${column} from messages where id=$1`, [saved.id])).rows[0][
        column
      ],
    ).toBe(true);
    await repository.undoMutation(id);
    expect(
      (await getPool().query(`select ${column} from messages where id=$1`, [saved.id])).rows[0][
        column
      ],
    ).toBe(false);
    expect(await repository.claimMutations()).toEqual([]);
    await expect(repository.undoMutation(id)).rejects.toThrow("Undo window expired");
  });

  it.each(["archive", "delete"])(
    "rejects overlapping %s actions so undo preserves original state",
    async (action) => {
      const saved = await message("overlap", 8);
      const until = new Date(Date.now() + 5_000).toISOString();
      const results = await Promise.allSettled([
        repository.enqueueAction(saved.id, action, until),
        repository.enqueueAction(saved.id, action, until),
      ]);
      const queued = results.find((result) => result.status === "fulfilled");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: new Error("This action is already pending"),
      });
      if (queued?.status !== "fulfilled") throw new Error("Action was not queued");
      await repository.undoMutation(queued.value);
      const column = action === "archive" ? "archived" : "deleted";
      expect(
        (await getPool().query(`select ${column} from messages where id=$1`, [saved.id])).rows[0][
          column
        ],
      ).toBe(false);
      expect(await repository.claimMutations()).toEqual([]);
    },
  );

  it("restores the original archived state instead of unarchiving on undo", async () => {
    const saved = await message("already archived", 8, { archived: true });
    const id = await repository.enqueueAction(
      saved.id,
      "archive",
      new Date(Date.now() + 5_000).toISOString(),
    );
    await repository.undoMutation(id);
    expect(
      (await getPool().query("select archived from messages where id=$1", [saved.id])).rows[0]
        .archived,
    ).toBe(true);
  });

  it("rejects undo after expiry and lets the worker claim the action", async () => {
    const saved = await message("expired", 8);
    const id = await repository.enqueueAction(
      saved.id,
      "delete",
      new Date(Date.now() - 1_000).toISOString(),
    );
    await expect(repository.undoMutation(id)).rejects.toThrow("Undo window expired");
    expect(await repository.claimMutations()).toMatchObject([{ id, action: "delete" }]);
    await expect(repository.undoMutation(id)).rejects.toThrow("Undo window expired");
  });

  it("cancels a queued reply exactly once and restores its draft", async () => {
    const original = await message("reply", 8);
    const draft = await repository.createOrUpdateDraft({
      accountId,
      to: [{ name: "Sender", address: "sender@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: reply",
      body: "Looks good.",
      replyToMessageId: original.id,
      forwardOfMessageId: null,
    });
    const id = await repository.enqueueSend(
      draft.id,
      [],
      new Date(Date.now() + 5_000).toISOString(),
    );
    expect(await repository.getDraft(draft.id)).toBeNull();
    expect(await repository.claimMutations()).toEqual([]);
    const results = await Promise.allSettled([
      repository.undoMutation(id),
      repository.undoMutation(id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await repository.getDraft(draft.id)).toMatchObject({
      id: draft.id,
      body: draft.body,
      replyToMessageId: original.id,
    });
    expect(await repository.claimMutations()).toEqual([]);
  });

  it("groups by conversation after view filtering and before pagination", async () => {
    await message("conversation", 8, { read: false });
    const latestInbound = await message("conversation", 10);
    await message("conversation", 11, { direction: "outbound" });
    await message("conversation", 12, { direction: "outbound" });
    const latestSent = await message("conversation", 13, { direction: "outbound" });
    const different = await message("different", 14);
    const separateAccount = await message("conversation", 9, {}, otherAccountId);
    await message("deleted", 16, { deleted: true });
    await message("archived", 17, { archived: true });
    await message("removed", 18, { tombstone: true });

    const first = await repository.listMessages({ view: "l1", limit: 1 });
    expect(first.messages.map((item) => item.id)).toEqual([different.id]);
    const second = await repository.listMessages({
      view: "l1",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.messages.map((item) => item.id)).toEqual([latestInbound.id]);
    expect(second.messages[0]?.read).toBe(false);
    expect(second.messages[0]).toMatchObject({ messageCount: 5, unreadCount: 1 });
    const third = await repository.listMessages({
      view: "l1",
      limit: 1,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.messages.map((item) => item.id)).toEqual([separateAccount.id]);
    expect(third.messages[0]?.messageCount).toBe(1);
    expect(third.nextCursor).toBeNull();
    const sent = await repository.listMessages({ view: "sent", limit: 50 });
    expect(sent.messages.map((item) => item.id)).toEqual([latestSent.id]);
    const filtered = await repository.listMessages({ view: "l1", accountId, limit: 50 });
    expect(filtered.messages).toHaveLength(2);
    const history = await repository.getThread(sent.messages[0]?.threadId ?? "");
    expect(history).toHaveLength(5);
  });

  it("counts the whole visible conversation and deduplicates participants, excluding trash and tombstones", async () => {
    await message("offer", 8, {
      read: false,
      from: [{ name: "Maya", address: "maya@example.com" }],
    });
    const latestInbound = await message("offer", 10, {
      from: [{ name: "Maya Chen", address: "MAYA@example.com" }],
    });
    await message("offer", 11, {
      direction: "outbound",
      from: [{ name: "Me", address: "me@example.com" }],
    });
    await message("offer", 12, { deleted: true, read: false });
    await message("offer", 13, { tombstone: true, read: false });
    const inbox = await repository.listMessages({ view: "l1", limit: 50 });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      id: latestInbound.id,
      messageCount: 3,
      unreadCount: 1,
      read: false,
    });
    expect(inbox.messages[0]?.participants).toEqual([
      { name: "Maya Chen", address: "MAYA@example.com" },
      { name: "Me", address: "me@example.com" },
    ]);
    const trash = await repository.listMessages({ view: "trash", limit: 50 });
    expect(trash.messages[0]).toMatchObject({ messageCount: 1, unreadCount: 1 });
    expect(await repository.getThread(inbox.messages[0]?.threadId ?? "")).toHaveLength(3);
    expect(await repository.getThread(inbox.messages[0]?.threadId ?? "", true)).toHaveLength(1);
  });

  it("groups search matches before limiting and preserves account and tier filters", async () => {
    await message("offer", 8, { read: false });
    await message("offer", 9);
    const latest = await message("offer", 10);
    await message("offer", 11, { direction: "outbound", subject: "Accepted", textBody: "Thanks" });
    await message("offer", 12, { deleted: true });
    const other = await message("offer", 7, {}, otherAccountId);
    const second = await message("another offer", 6);
    const results = await repository.search({ q: "offer", limit: 2 });
    expect(results.messages).toHaveLength(2);
    expect(new Set(results.messages.map((item) => item.threadId)).size).toBe(2);
    expect(results.messages[0]).toMatchObject({
      id: latest.id,
      messageCount: 4,
      unreadCount: 1,
      read: false,
    });
    const all = await repository.search({ q: "offer", limit: 50 });
    expect(all.messages.map((item) => item.id)).toEqual([latest.id, other.id, second.id]);
    const filtered = await repository.search({ q: "offer", accountId, limit: 50 });
    expect(filtered.messages.map((item) => item.id)).toEqual([latest.id, second.id]);
    await getPool().query(
      "insert into classifications(message_id,model_tier,reasoning,model,prompt_version) values($1,3,'test','test','test')",
      [second.id],
    );
    expect(
      (await repository.search({ q: "offer", tier: 3, limit: 50 })).messages.map((item) => item.id),
    ).toEqual([second.id]);
  });

  it("preserves tier-specific membership when other messages in the conversation have a different tier", async () => {
    const important = await message("conversation", 8);
    const newsletter = await message("conversation", 9);
    for (const [id, tier] of [
      [important.id, 1],
      [newsletter.id, 3],
    ]) {
      await getPool().query(
        "insert into classifications(message_id,model_tier,reasoning,model,prompt_version) values($1,$2,'test','test','test')",
        [id, tier],
      );
    }
    expect(
      (await repository.listMessages({ view: "l1", limit: 50 })).messages.map((item) => item.id),
    ).toEqual([important.id]);
    expect(
      (await repository.listMessages({ view: "l3", limit: 50 })).messages.map((item) => item.id),
    ).toEqual([newsletter.id]);
  });

  it("persists summaries across list, detail, thread, and search without losing manual tiers", async () => {
    const source = await message("summary", 9);
    await repository.setTierOverride(source.id, 2);
    await repository.saveClassification(source.id, {
      tier: 1,
      reasoning: "A professor directly requests a reply.",
      summary: "  Send the revised lab by Friday.  ",
      plainText: "Please send the revised lab by Friday.",
      model: "test-model",
      promptVersion: "summary-test",
    });
    const expected = {
      aiSummary: "Send the revised lab by Friday.",
      reasoning: "A professor directly requests a reply.",
      tier: 2,
      modelTier: 1,
    };
    expect((await repository.listMessages({ view: "l2", limit: 50 })).messages[0]).toMatchObject(
      expected,
    );
    expect(await repository.getMessage(source.id)).toMatchObject(expected);
    const detail = await repository.getMessage(source.id);
    expect((await repository.getThread(detail?.threadId ?? ""))[0]).toMatchObject(expected);
    expect((await repository.search({ q: "summary", limit: 50 })).messages[0]).toMatchObject(
      expected,
    );
    await repository.saveClassification(source.id, {
      tier: 3,
      reasoning: "An informational update.",
      summary: "The lab was accepted.",
      plainText: "Accepted.",
      model: "test-model",
      promptVersion: "summary-test-2",
    });
    expect(await repository.getMessage(source.id)).toMatchObject({
      aiSummary: "The lab was accepted.",
      modelTier: 3,
      tier: 2,
    });
  });

  it("keeps older and unsorted messages readable without inventing AI insights", async () => {
    const source = await message("legacy", 9);
    expect(await repository.getMessage(source.id)).toMatchObject({
      aiSummary: null,
      reasoning: null,
      modelTier: null,
    });
    await repository.setTierOverride(source.id, 2);
    expect(await repository.getMessage(source.id)).toMatchObject({
      aiSummary: null,
      reasoning: null,
      modelTier: null,
      tier: 2,
    });
    await getPool().query(
      "update classifications set model='legacy',reasoning='A real model reason' where message_id=$1",
      [source.id],
    );
    expect(await repository.getMessage(source.id)).toMatchObject({
      aiSummary: null,
      reasoning: "A real model reason",
      modelTier: 1,
    });
  });

  it.each(["archive", "delete"] as const)(
    "applies grouped %s only within the view and restores every message",
    async (action) => {
      const members = await Promise.all([8, 9, 10].map((hour) => message("group", hour)));
      const archived = await message("group", 11, { archived: true });
      const deleted = await message("group", 12, { deleted: true });
      const otherTier = await message("group", 13);
      await repository.setTierOverride(otherTier.id, 3);
      const threadId = (await repository.getMessage(members[0]?.id ?? ""))?.threadId ?? "";
      const receipt = await repository.enqueueThreadAction(
        threadId,
        { action, view: "l1", accountId },
        new Date(Date.now() + 5000).toISOString(),
      );
      const rows = (await getPool().query("select * from mutation_outbox")).rows;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.payload.groupId === receipt)).toBe(true);
      expect(new Set(rows.map((row) => row.payload.undoUntil)).size).toBe(1);
      expect(await repository.claimMutations()).toEqual([]);
      expect((await repository.listMessages({ view: "l1", limit: 50 })).messages).toEqual([]);
      expect((await repository.listMessages({ view: "l1", limit: 50 })).messages).toEqual([]);
      expect(await messageState(archived.id)).toMatchObject({
        archived: true,
        deleted: false,
      });
      expect(await messageState(deleted.id)).toMatchObject({
        deleted: true,
        archived: false,
      });
      expect(await messageState(otherTier.id)).toMatchObject({
        archived: false,
        deleted: false,
      });
      await repository.undoMutation(receipt);
      expect((await getPool().query("select * from mutation_outbox")).rows).toEqual([]);
      expect(await repository.claimMutations()).toEqual([]);
      for (const member of members)
        expect(await messageState(member.id)).toMatchObject({
          archived: false,
          deleted: false,
        });
      expect((await repository.listMessages({ view: "l1", limit: 50 })).messages).toHaveLength(1);
    },
  );

  it("handles trash deletion, pending duplicates, expired undo, and missing threads", async () => {
    const source = await message("trash-group", 8, { deleted: true });
    await message("trash-group", 9, { deleted: true });
    const threadId = (await repository.getMessage(source.id))?.threadId ?? "";
    const receipt = await repository.enqueueThreadAction(
      threadId,
      { action: "delete", view: "trash" },
      new Date(Date.now() + 5000).toISOString(),
    );
    await expect(
      repository.enqueueThreadAction(threadId, { action: "delete", view: "trash" }),
    ).rejects.toThrow("already pending");
    expect((await getPool().query("select * from mutation_outbox")).rows).toHaveLength(2);
    await repository.undoMutation(receipt);
    expect((await messageState(source.id)).deleted).toBe(true);
    const expired = await repository.enqueueThreadAction(
      threadId,
      { action: "delete", view: "trash" },
      new Date(Date.now() - 1000).toISOString(),
    );
    await expect(repository.undoMutation(expired)).rejects.toThrow("Undo window expired");
    await expect(
      repository.enqueueThreadAction(randomUUID(), { action: "archive", view: "l1" }),
    ).rejects.toThrow("Message not found");
  });

  async function messageState(id: string) {
    return (await getPool().query("select archived,deleted from messages where id=$1", [id]))
      .rows[0];
  }

  async function enqueueDraft() {
    const reply = await message("reply", 8);
    const forward = await message("forward", 9);
    const draft = await repository.createOrUpdateDraft({
      accountId,
      to: [{ name: "Recipient", address: "to@example.com" }],
      cc: [{ name: "CC", address: "cc@example.com" }],
      bcc: [{ name: "BCC", address: "bcc@example.com" }],
      subject: "Recovered reply",
      body: "Do not lose this reply",
      replyToMessageId: reply.id,
      forwardOfMessageId: forward.id,
    });
    const id = await repository.enqueueSend(draft.id, []);
    expect(await repository.getDraft(draft.id)).toBeNull();
    return { id, draft };
  }

  it.each([false, true])(
    "restores a terminally failed unattempted send (deleted references: %s)",
    async (deleted) => {
      const { id, draft } = await enqueueDraft();
      if (deleted) await getPool().query("delete from messages where account_id=$1", [accountId]);
      await getPool().query(
        "update mutation_outbox set attempts=12,status='processing' where id=$1",
        [id],
      );
      await repository.failMutation(id, "Graph 502");
      const restored = await repository.getDraft(draft.id);
      expect(restored).toEqual({
        ...draft,
        replyToMessageId: deleted ? null : draft.replyToMessageId,
        forwardOfMessageId: deleted ? null : draft.forwardOfMessageId,
        updatedAt: expect.any(String),
      });
      expect(Date.parse(restored?.updatedAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(draft.updatedAt),
      );
      expect(
        (await getPool().query("select status,last_error from mutation_outbox where id=$1", [id]))
          .rows[0],
      ).toEqual({ status: "failed", last_error: "Graph 502" });
      await repository.deleteDraft(draft.id);
      await repository.failMutation(id, "Repeated failure");
      expect(await repository.getDraft(draft.id)).toBeNull();
    },
  );

  it("does not overwrite an existing draft when restoring a failed send", async () => {
    const { id, draft } = await enqueueDraft();
    await getPool().query("insert into drafts(id,account_id,body) values($1,$2,'New content')", [
      draft.id,
      accountId,
    ]);
    await getPool().query("update mutation_outbox set attempts=12 where id=$1", [id]);
    await repository.failMutation(id, "Graph 502");
    expect((await repository.getDraft(draft.id))?.body).toBe("New content");
  });

  it.each([1, 8, 11])(
    "does not restore a send after non-terminal failure at attempt %s",
    async (attempts) => {
      const { id, draft } = await enqueueDraft();
      await getPool().query(
        "update mutation_outbox set attempts=$2,status='processing' where id=$1",
        [id, attempts],
      );
      await repository.failMutation(id, "Graph 502");
      expect(await repository.getDraft(draft.id)).toBeNull();
      expect(
        (await getPool().query("select status from mutation_outbox where id=$1", [id])).rows[0]
          .status,
      ).toBe("pending");
    },
  );

  it("uses the extended retry budget for non-send actions without restoring drafts", async () => {
    const source = await message("archive", 8);
    const id = await repository.enqueueAction(source.id, "archive");
    for (const attempts of [8, 11, 12]) {
      await getPool().query(
        "update mutation_outbox set attempts=$2,status='processing' where id=$1",
        [id, attempts],
      );
      await repository.failMutation(id, "Graph 502");
      expect(
        (await getPool().query("select status from mutation_outbox where id=$1", [id])).rows[0]
          .status,
      ).toBe(attempts === 12 ? "failed" : "pending");
    }
    expect(await repository.listDrafts()).toEqual([]);
    await repository.failMutation(randomUUID(), "Missing mutation");
    expect(await repository.listDrafts()).toEqual([]);
  });

  it("rolls back the failure transition if restoring the draft fails", async () => {
    const { id, draft } = await enqueueDraft();
    await getPool().query(
      "update mutation_outbox set attempts=12,status='processing',payload=jsonb_set(payload,'{draft,accountId}',to_jsonb($2::text)) where id=$1",
      [id, randomUUID()],
    );
    await expect(repository.failMutation(id, "Graph 502")).rejects.toThrow();
    expect(
      (await getPool().query("select status from mutation_outbox where id=$1", [id])).rows[0]
        .status,
    ).toBe("processing");
    expect(await repository.getDraft(draft.id)).toBeNull();
  });

  it("atomically permits only one send attempt and stops retries after dispatch", async () => {
    const { id, draft } = await enqueueDraft();
    await getPool().query("update mutation_outbox set status='processing',attempts=1 where id=$1", [
      id,
    ]);
    const results = await Promise.allSettled([
      repository.recordSendAttempt(id),
      repository.recordSendAttempt(id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await repository.failMutation(id, "Connection reset");
    const row = (
      await getPool().query("select status,last_error,payload from mutation_outbox where id=$1", [
        id,
      ])
    ).rows[0];
    expect(row.status).toBe("failed");
    expect(row.payload.sendAttemptedAt).toBeTruthy();
    expect(row.last_error).toContain("Automatic resend blocked");
    expect(await repository.getDraft(draft.id)).toBeNull();
    expect(await repository.claimMutations()).toEqual([]);
  });

  it("degrades health when any connected account has not synced recently", async () => {
    await repository.heartbeat("main");
    await repository.finishSync(accountId, null, true);
    const recent = await repository.health();
    expect(recent.status).toBe("degraded");
    expect(recent.sync).toEqual({
      accounts: 2,
      needsReauth: 0,
      oldestSuccessfulSyncAt: expect.any(String),
      stale: 1,
      fresh: false,
    });

    await repository.finishSync(otherAccountId, null, true);
    const fresh = await repository.health();
    expect(fresh.status).toBe("ok");
    expect(fresh.sync).toEqual({ ...recent.sync, stale: 0, fresh: true });

    const { rows } = await getPool().query<{ last_synced_at: Date }>(
      "update accounts set last_synced_at=now() - interval '4 minutes' where id=$1 returning last_synced_at",
      [accountId],
    );
    const stale = await repository.health();
    expect(stale.status).toBe("degraded");
    expect(stale.sync).toEqual({
      ...recent.sync,
      oldestSuccessfulSyncAt: rows[0]?.last_synced_at.toISOString(),
    });
  });

  it("degrades health for a reauth account even if its last sync is recent", async () => {
    await repository.heartbeat("main");
    await repository.finishSync(accountId, null, true);
    await repository.finishSync(otherAccountId, null, true);
    await repository.failSync(accountId, "unauthorized", true);
    expect(await repository.health()).toMatchObject({
      status: "degraded",
      sync: { accounts: 2, needsReauth: 1, stale: 0, fresh: false },
    });
  });

  it("treats no connected accounts as fresh without masking a missing worker heartbeat", async () => {
    await getPool().query("truncate accounts cascade; truncate worker_state");
    const empty = await repository.health();
    expect(empty.status).toBe("degraded");
    expect(empty.sync).toEqual({
      accounts: 0,
      needsReauth: 0,
      oldestSuccessfulSyncAt: null,
      stale: 0,
      fresh: true,
    });
    await repository.heartbeat("main");
    expect((await repository.health()).status).toBe("ok");
  });
});
