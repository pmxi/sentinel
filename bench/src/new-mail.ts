import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Page } from "playwright";

import { closeDb, getPool, signalMessages, validateSQLitePath } from "./sqlite-db.ts";
import { prepareWarmMailbox } from "./warm.ts";

export const MAILBOX_CHANGED_CHANNEL = "sent_mailbox_changed";
export type NewMailDb = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
export type NewMailFixture = {
  id: string;
  thread: string;
  account: string;
  email: string;
  date: Date;
  subject: string;
};
export const epochNow = () => performance.timeOrigin + performance.now();
export const closeNewMailDatabase = closeDb;

export function validateNewMailTarget(target: URL, database: string | undefined) {
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!local.has(target.hostname)) throw new Error("New-mail latency requires a local fake server");
  validateSQLitePath(database);
}

export function newMailPhase(iteration: number, iterations: number) {
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(iteration))
    throw new Error("Invalid new-mail phase sample");
  let stride = Math.ceil(iterations / 2);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  while (gcd(stride, iterations) !== 1) stride++;
  return (
    ((((((iteration + 2) * stride) % iterations) + iterations) % iterations) * 4000) / iterations
  );
}

export async function calibrateClock(read: () => Promise<number>, now = epochNow) {
  let best = { offset: 0, uncertainty: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = now(),
      remote = await read(),
      after = now();
    if (![before, remote, after].every(Number.isFinite) || after < before)
      throw new Error("Clock calibration failed");
    const uncertainty = (after - before) / 2;
    if (uncertainty < best.uncertainty)
      best = { offset: remote - (before + after) / 2, uncertainty };
  }
  return best;
}

export async function prepareNewMailFixture(db: NewMailDb): Promise<NewMailFixture> {
  const row = (
    await db.query(
      "select a.id,a.email,(select max(strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ',max(received_at),'+1 second')) from messages) as date from accounts a order by a.id limit 1",
    )
  ).rows[0];
  if (!row || typeof row.id !== "string" || typeof row.email !== "string")
    throw new Error("Seed the fake mailbox before measuring new-mail latency");
  const date = row.date instanceof Date ? row.date : new Date(String(row.date));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid fake mailbox date");
  const id = randomUUID();
  return {
    id,
    thread: randomUUID(),
    account: row.id,
    email: row.email,
    date,
    subject: `New mail latency ${id}`,
  };
}

export async function publishNewMail(db: NewMailDb, fixture: NewMailFixture, start = () => {}) {
  await db.query("begin");
  try {
    start();
    await db.query(
      "insert into threads(id,account_id,provider_thread_id,subject,last_message_at) values($1,$2,$3,$4,$5)",
      [
        fixture.thread,
        fixture.account,
        `bench-live-${fixture.thread}`,
        fixture.subject,
        fixture.date,
      ],
    );
    await db.query(
      "insert into messages(id,account_id,thread_id,provider_message_id,subject,from_addresses,to_addresses,snippet,text_body,received_at,direction) values($1,$2,$3,$4,$5,$6,$7,'New benchmark mail','New benchmark mail body',$8,'inbound')",
      [
        fixture.id,
        fixture.account,
        fixture.thread,
        `bench-live-${fixture.id}`,
        fixture.subject,
        JSON.stringify([{ name: "Benchmark sender", address: "live@example.test" }]),
        JSON.stringify([{ address: fixture.email }]),
        fixture.date,
      ],
    );
    await db.query(
      "insert into classifications(message_id,model_tier,reasoning,model,prompt_version) values($1,1,'Synthetic benchmark classification','benchmark','benchmark-v1')",
      [fixture.id],
    );
    await signalMessages(db, [fixture.id]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

export async function removeNewMail(db: NewMailDb, fixture: NewMailFixture) {
  await db.query("begin");
  try {
    await db.query("delete from messages where id=$1 and provider_message_id=$2", [
      fixture.id,
      `bench-live-${fixture.id}`,
    ]);
    await db.query("delete from threads where id=$1 and provider_thread_id=$2", [
      fixture.thread,
      `bench-live-${fixture.thread}`,
    ]);
    await signalMessages(db, [fixture.id]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

export async function measureNewMail(page: Page, iteration: number, iterations: number) {
  await prepareWarmMailbox(page);
  await page.waitForFunction(
    () =>
      !document.documentElement.dataset.sentLive ||
      document.documentElement.dataset.sentLive === "ready",
  );
  const clock = await calibrateClock(() =>
    page.evaluate(() => performance.timeOrigin + performance.now()),
  );
  const client = await getPool().connect();
  let fixture: NewMailFixture | undefined;
  try {
    fixture = await prepareNewMailFixture(client);
    await page.evaluate(
      (subject) => window.__sentBench.armExternal({ kind: "new_mail", subject }),
      fixture.subject,
    );
    await page.waitForTimeout(newMailPhase(iteration, iterations));
    let started = 0;
    await publishNewMail(client, fixture, () => {
      started = epochNow();
    });
    await page.waitForFunction(() => window.__sentBench.endEpoch !== null);
    const ended = await page.evaluate(() => window.__sentBench.endEpoch as number);
    const ms = ended - (started + clock.offset);
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid new-mail paint boundary");
    await page.evaluate(
      ({ started, ms }) => {
        window.__sentBench.startEpoch = started;
        window.__sentBench.result = ms;
      },
      { started: started + clock.offset, ms },
    );
    return {
      ms,
      startEpoch: started,
      endEpoch: ended - clock.offset,
      clockUncertaintyMs: clock.uncertainty,
    };
  } finally {
    try {
      if (fixture) await removeNewMail(client, fixture);
    } finally {
      client.release();
    }
  }
}
