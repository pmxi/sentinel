import "dotenv/config";
import { closeDb, getPool, SentServices } from "../packages/core/src/index.ts";

type CorruptedRow = {
  account_id: string;
  message_id: string;
  provider_message_id: string;
  folder_id: string;
  folder_name: string;
};

const apply = process.argv.includes("--apply");
const skipAi = process.argv.includes("--skip-ai");
const concurrencyArgument = process.argv.find((argument) => argument.startsWith("--concurrency="));
const concurrency = Number(concurrencyArgument?.split("=")[1] ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer");
}

async function concurrently<T>(items: T[], task: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

const services = new SentServices();

try {
  const affected = await getPool().query<CorruptedRow>(
    `select distinct on (m.id)
      m.account_id,
      m.id as message_id,
      m.provider_message_id,
      coalesce(pc.provider_id,m.native_state->>'parentFolderId') as folder_id,
      coalesce(pc.name,'Folder') as folder_name
    from messages m
    join accounts a on a.id=m.account_id
    left join message_containers mc on mc.message_id=m.id
    left join provider_containers pc
      on pc.account_id=mc.account_id and pc.provider_id=mc.provider_id
    where a.provider='microsoft'
      and m.subject='(no subject)'
      and jsonb_array_length(m.from_addresses)=0
      and not m.tombstone
      and abs(extract(epoch from (m.updated_at-m.received_at))) < 1
      and not (m.native_state ? 'isDraft')
    order by m.id,pc.name nulls last`,
  );

  process.stdout.write(`Found ${affected.rowCount ?? 0} corrupted Microsoft messages.\n`);
  if (!apply || affected.rows.length === 0) {
    if (!apply) process.stdout.write("Dry run only; pass --apply to repair them.\n");
    process.exitCode = 0;
  } else {
    const accounts = new Map(
      (await services.repository.listStoredAccounts())
        .filter((account) => account.provider === "microsoft")
        .map((account) => [account.id, account]),
    );
    const repairedMessageIds: string[] = [];
    let tombstoned = 0;

    for (const [accountId, accountRows] of Map.groupBy(affected.rows, (row) => row.account_id)) {
      const account = accounts.get(accountId);
      if (!account) throw new Error(`Microsoft account ${accountId} no longer exists`);
      const results = await services.providers.microsoft.refetchMessages(
        account,
        accountRows.map((row) => ({
          providerMessageId: row.provider_message_id,
          folderId: row.folder_id,
          folderName: row.folder_name,
        })),
      );
      const rowsByProviderId = new Map(accountRows.map((row) => [row.provider_message_id, row]));
      for (const result of results) {
        const row = rowsByProviderId.get(result.providerMessageId);
        if (!row) continue;
        if (!result.message) {
          await services.repository.tombstoneMessages(accountId, [result.providerMessageId]);
          tombstoned += 1;
          continue;
        }
        const saved = await services.repository.upsertMessage(accountId, result.message);
        repairedMessageIds.push(saved.id);
      }
    }

    process.stdout.write(
      `Repaired ${repairedMessageIds.length} messages and tombstoned ${tombstoned}.\n`,
    );

    if (!skipAi && repairedMessageIds.length > 0) {
      await Promise.all([
        getPool().query("delete from classifications where message_id=any($1::uuid[])", [
          repairedMessageIds,
        ]),
        getPool().query("delete from embeddings where message_id=any($1::uuid[])", [
          repairedMessageIds,
        ]),
        getPool().query("delete from classification_failures where message_id=any($1::uuid[])", [
          repairedMessageIds,
        ]),
      ]);

      const failures: Array<{ id: string; error: string }> = [];
      let completed = 0;
      await concurrently(repairedMessageIds, async (messageId) => {
        try {
          await services.classifyMessage(messageId);
          await services.embedMessage(messageId);
          completed += 1;
          process.stdout.write(
            `Refreshed intelligence ${completed}/${repairedMessageIds.length}.\n`,
          );
        } catch (error) {
          failures.push({
            id: messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      if (failures.length > 0) {
        process.stderr.write(`Intelligence refresh failed for ${failures.length} messages.\n`);
        for (const failure of failures) {
          process.stderr.write(`${failure.id}: ${failure.error}\n`);
        }
        process.exitCode = 1;
      }
    }
  }
} finally {
  await closeDb();
}
