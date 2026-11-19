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
    const third = await repository.listMessages({
      view: "l1",
      limit: 1,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.messages.map((item) => item.id)).toEqual([separateAccount.id]);
    expect(third.nextCursor).toBeNull();
    const sent = await repository.listMessages({ view: "sent", limit: 50 });
    expect(sent.messages.map((item) => item.id)).toEqual([latestSent.id]);
    const filtered = await repository.listMessages({ view: "l1", accountId, limit: 50 });
    expect(filtered.messages).toHaveLength(2);
    const history = await repository.getThread(sent.messages[0]?.threadId ?? "");
    expect(history).toHaveLength(5);
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

  it("atomically permits only one send attempt and stops retries after dispatch", async () => {
    const id = randomUUID();
    await getPool().query(
      "insert into mutation_outbox(id,idempotency_key,account_id,action,status,attempts) values($1::uuid,$1::text,$2,'send','processing',1)",
      [id, accountId],
    );
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
