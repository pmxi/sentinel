import "dotenv/config";
import { env, SentServices } from "@sent/core";
import { type Job, PgBoss } from "pg-boss";

const services = new SentServices();
const boss = new PgBoss({ connectionString: env().DATABASE_URL, application_name: "sent-worker" });

boss.on("error", (error) => {
  process.stderr.write(`worker error: ${error.message}\n`);
});

await boss.start();

for (const queue of [
  "poll-accounts",
  "sync-account",
  "classify-message",
  "embed-message",
  "process-outbox",
]) {
  await boss.createQueue(queue);
}

await boss.work("poll-accounts", async (_jobs: Job[]) => {
  const accounts = await services.repository.listStoredAccounts();
  for (const account of accounts) {
    await boss.send(
      "sync-account",
      { accountId: account.id },
      {
        singletonKey: account.id,
        retryLimit: 6,
        retryDelay: 15,
        retryBackoff: true,
        expireInSeconds: 60 * 30,
      },
    );
  }
  return { queued: accounts.length };
});

await boss.work<{ accountId: string }>("sync-account", { localConcurrency: 2 }, async (jobs) => {
  let changed = 0;
  for (const job of jobs) {
    const messageIds = await services.syncAccount(job.data.accountId);
    changed += messageIds.length;
    if (env().OPENAI_API_KEY) {
      for (const messageId of messageIds) {
        await boss.send(
          "classify-message",
          { messageId },
          { singletonKey: messageId, retryLimit: 5, retryDelay: 30, retryBackoff: true },
        );
        await boss.send(
          "embed-message",
          { messageId },
          { singletonKey: messageId, retryLimit: 5, retryDelay: 30, retryBackoff: true },
        );
      }
    }
    const cursor = await services.repository.getSyncCursor(job.data.accountId);
    if (!cursor.backfillComplete) {
      await boss.sendAfter(
        "sync-account",
        { accountId: job.data.accountId },
        {
          singletonKey: job.data.accountId,
          retryLimit: 6,
          retryDelay: 15,
          retryBackoff: true,
          expireInSeconds: 60 * 30,
        },
        5,
      );
    }
  }
  return { changed };
});

await boss.work<{ messageId: string }>(
  "classify-message",
  { localConcurrency: 3 },
  async (jobs) => {
    for (const job of jobs) await services.classifyMessage(job.data.messageId);
    return { classified: jobs.length };
  },
);

await boss.work<{ messageId: string }>("embed-message", { localConcurrency: 3 }, async (jobs) => {
  for (const job of jobs) await services.embedMessage(job.data.messageId);
  return { embedded: jobs.length };
});

await boss.work("process-outbox", async (_jobs: Job[]) => ({
  processed: await services.processOutbox(),
}));

const tick = async () => {
  await Promise.all([
    boss.sendThrottled("poll-accounts", {}, null, 20, "poller"),
    boss.sendThrottled("process-outbox", {}, null, 10, "outbox"),
    services.repository.heartbeat("main", { pid: process.pid }),
  ]);
};

await tick();
const timer = setInterval(
  () =>
    void tick().catch((error) => {
      process.stderr.write(
        `worker tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }),
  30_000,
);

const shutdown = async (signal: string) => {
  clearInterval(timer);
  process.stdout.write(`worker received ${signal}; shutting down\n`);
  await boss.stop({ graceful: true, timeout: 30_000 });
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
