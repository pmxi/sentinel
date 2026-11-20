import { AS_OF, generateMessages, id, parseSeed } from "./data.ts";
import { closeDb, sqlite } from "./sqlite-db.ts";

const db = sqlite(),
  seed = parseSeed(process.argv.slice(2));
db.exec("begin immediate");
try {
  db.exec("delete from accounts; delete from worker_state");
  const account = db.prepare(
    "insert into accounts(id,provider,email,display_name,encrypted_credentials,created_at,updated_at) values(?,?,?,'Alex Morgan','benchmark-dummy',?,?)",
  );
  for (const [n, provider] of [
    [1, "gmail"],
    [2, "microsoft"],
  ] as const)
    account.run(
      id(1, n),
      provider,
      `alex@${provider}.example.test`,
      new Date(AS_OF).toISOString(),
      new Date(AS_OF).toISOString(),
    );
  const thread = db.prepare(
    "insert into threads(id,account_id,provider_thread_id,subject,last_message_at,created_at,updated_at) values(?,?,?,?,?,?,?) on conflict(id) do update set last_message_at=max(threads.last_message_at,excluded.last_message_at),updated_at=max(threads.updated_at,excluded.updated_at)",
  );
  const message = db.prepare(
    "insert into messages(id,account_id,thread_id,provider_message_id,internet_message_id,subject,from_addresses,to_addresses,sent_at,received_at,snippet,text_body,html_body,headers,attachments,direction,read,archived,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const classification = db.prepare(
    "insert into classifications(message_id,model_tier,reasoning,plain_text,model,prompt_version,classified_at,updated_at) values(?,?,'Synthetic benchmark classification',?,'benchmark','benchmark-v1',?,?)",
  );
  let count = 0;
  for (const r of generateMessages(seed)) {
    thread.run(
      r.thread_id,
      r.account_id,
      r.provider_thread_id,
      r.subject,
      r.received_at,
      r.received_at,
      r.received_at,
    );
    message.run(
      r.id,
      r.account_id,
      r.thread_id,
      r.provider_message_id,
      r.headers["message-id"],
      r.subject,
      JSON.stringify(r.from_addresses),
      JSON.stringify(r.to_addresses),
      r.received_at,
      r.received_at,
      r.snippet,
      r.text_body,
      r.html_body,
      JSON.stringify(r.headers),
      JSON.stringify(r.attachments),
      r.direction,
      Number(r.read),
      Number(r.archived),
      r.received_at,
      r.received_at,
    );
    if (r.tier !== null)
      classification.run(r.id, r.tier, r.text_body, r.received_at, r.received_at);
    count++;
  }
  db.exec("commit; analyze");
  console.log(
    "Seed",
    seed,
    "messages",
    count,
    "threads",
    db.prepare("select count(*) n from threads").get()?.n,
  );
} catch (e) {
  db.exec("rollback");
  throw e;
} finally {
  await closeDb();
}
