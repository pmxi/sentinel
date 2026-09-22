import "dotenv/config";
import { closeDb, getPool, SentServices } from "../packages/core/src/index.ts";

const apply = process.argv.includes("--apply");
const services = new SentServices();
try {
  for (const account of await services.repository.listStoredAccounts()) {
    if (account.provider !== "microsoft") continue;
    const sentFolderId = await services.providers.microsoft.getSentFolderId(account);
    const where = `account_id=$1 and not tombstone and direction<>'outbound'
      and native_state->>'parentFolderId'=$2`;
    const count = await getPool().query(`select count(*) from messages where ${where}`, [
      account.id,
      sentFolderId,
    ]);
    console.log(`${account.email}: ${count.rows[0].count} Sent Items messages need correction`);
    if (apply) {
      const result = await getPool().query(
        `update messages set direction='outbound', native_state=native_state || '{"isSent":true}'::jsonb, updated_at=now() where ${where}`,
        [account.id, sentFolderId],
      );
      console.log(`Corrected ${result.rowCount} messages; provider mailbox unchanged`);
    }
  }
  if (!apply) console.log("Dry run only; pass --apply after backing up the database.");
} finally {
  await closeDb();
}
