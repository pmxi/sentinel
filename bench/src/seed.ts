import { performance } from "node:perf_hooks";
import { AS_OF, generateMessages, id, parseSeed, validateDatabaseUrl } from "./data.ts";
import { closeDb, getPool, migrate } from "./db.ts";

validateDatabaseUrl(process.env.DATABASE_URL);
const seed = parseSeed(process.argv.slice(2));
const started = performance.now();
const pool = getPool();
const client = await pool.connect();
try {
  await migrate(client);
  await client.query("begin");
  await client.query("truncate accounts, drafts, mutation_outbox, worker_state cascade");
  await client.query(
    `insert into accounts(id,provider,email,display_name,encrypted_credentials,created_at,updated_at)
    values ($1,'gmail','alex@gmail.example.test','Alex Morgan','benchmark-dummy',$3,$3),
    ($2,'microsoft','alex@microsoft.example.test','Alex Morgan','benchmark-dummy',$3,$3)`,
    [id(1, 1), id(1, 2), new Date(AS_OF)],
  );
  type Row = ReturnType<typeof generateMessages> extends Generator<infer T> ? T : never;
  const insertBatch = async (rows: Row[]) => {
    if (!rows.length) return;
    const payload = JSON.stringify(rows);
    await client.query(
      `insert into threads(id,account_id,provider_thread_id,subject,last_message_at,created_at,updated_at)
      select distinct on (thread_id) thread_id,account_id,provider_thread_id,subject,received_at,received_at,received_at
      from jsonb_to_recordset($1::jsonb) as x(thread_id uuid,account_id uuid,provider_thread_id text,subject text,received_at timestamptz)
      order by thread_id,received_at desc
      on conflict(id) do update set last_message_at=excluded.last_message_at,updated_at=excluded.updated_at`,
      [payload],
    );
    await client.query(
      `insert into messages(id,account_id,thread_id,provider_message_id,internet_message_id,
      subject,from_addresses,to_addresses,sent_at,received_at,snippet,text_body,html_body,headers,attachments,direction,read,archived,created_at,updated_at)
      select id,account_id,thread_id,provider_message_id,headers->>'message-id',subject,from_addresses,to_addresses,
      received_at,received_at,snippet,text_body,html_body,headers,attachments,direction::message_direction,read,archived,received_at,received_at
      from jsonb_to_recordset($1::jsonb) as x(id uuid,account_id uuid,thread_id uuid,provider_message_id text,
      subject text,from_addresses jsonb,to_addresses jsonb,received_at timestamptz,snippet text,text_body text,html_body text,
      headers jsonb,attachments jsonb,direction text,read boolean,archived boolean)`,
      [payload],
    );
    await client.query(
      `insert into classifications(message_id,model_tier,reasoning,plain_text,model,prompt_version,classified_at,updated_at)
      select id,tier,'Synthetic benchmark classification',text_body,'benchmark','benchmark-v1',received_at,received_at
      from jsonb_to_recordset($1::jsonb) as x(id uuid,tier integer,text_body text,received_at timestamptz) where tier is not null`,
      [payload],
    );
  };
  let batch: Row[] = [];
  for (const row of generateMessages(seed)) {
    batch.push(row);
    if (batch.length === 100) {
      await insertBatch(batch);
      batch = [];
    }
  }
  await insertBatch(batch);
  await client.query("commit");
  await client.query("analyze messages, threads, classifications");
  console.log(
    `Seed ${seed}: 23032 messages / 20986 threads in ${((performance.now() - started) / 1000).toFixed(2)}s`,
  );
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await closeDb();
}
