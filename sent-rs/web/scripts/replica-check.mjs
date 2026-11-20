import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "package.json"));
const { Client } = createRequire(join(root, "packages/core/package.json"))("pg");
const database = process.env.SENT_TEST_DATABASE_URL;
assert(database, "Set SENT_TEST_DATABASE_URL");
const parsed = new URL(database);
assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
assert(/^\/sent_test_[a-zA-Z0-9_]+$/.test(parsed.pathname));
const output = join(homedir(), "replica-check", `${Date.now()}`);
await mkdir(output, { recursive: true });
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const url = `http://localhost:${port}`,
  password = "sent-replica-local-test-password";
const env = {
  ...process.env,
  DATABASE_URL: database,
  SENT_FAKE_PROVIDERS: "true",
  OPENAI_API_KEY: "",
  SESSION_SECRET: "sent-replica-test-session-secret-123",
  SENT_PASSWORD_HASH: await require("argon2").hash(password),
  HOST: "127.0.0.1",
  PORT: String(port),
  SENT_PUBLIC_URL: url,
  WEB_DIST_PATH: join(root, "sent-rs/web/dist"),
};
const seed = spawnSync(
  join(root, "sent-rs/target/release/sent-seed"),
  ["--reset", "--messages", "3000"],
  { cwd: root, env, encoding: "utf8" },
);
assert.equal(seed.status, 0, seed.stderr);
const log = createWriteStream(join(output, "server.log"));
const server = spawn(join(root, "sent-rs/target/release/sent-server"), [], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
const db = new Client({ connectionString: database });
await db.connect();
const recent = (
  await db.query(
    "select m.id from messages m join classifications c on c.message_id=m.id where m.direction='inbound' and not m.archived and not m.deleted limit 1",
  )
).rows[0];
await db.query(
  "update messages set received_at=now()-interval '30 days',text_body='Recent background body: this message is cached before it is ever opened.',html_body=null where id=$1",
  [recent.id],
);
await db.query("update classifications set manual_tier=1,plain_text=null where message_id=$1", [
  recent.id,
]);
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    assert.equal(server.exitCode, null);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    assert(attempt < 100);
    await new Promise((done) => setTimeout(done, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.SENT_CHROMIUM_PATH ??
      require("./bench/node_modules/playwright").chromium.executablePath(),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes("replica-worker")) {
          let id = -1;
          window.__replicaStats = () =>
            new Promise((resolve, reject) => {
              const call = id--;
              const listener = (event) => {
                if (event.data.id !== call) return;
                this.removeEventListener("message", listener);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
              };
              this.addEventListener("message", listener);
              this.postMessage({ id: call, method: "stats", args: [] });
            });
        }
      }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [],
    requests = [],
    bodyRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const target = new URL(request.url());
    requests.push(target.pathname);
    if (target.pathname === "/api/sync/bodies")
      bodyRequests.push(...target.searchParams.get("ids").split(","));
  });
  await page.goto(`${url}/inbox/l1`);
  const login = async () => {
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    if (new URL(page.url()).pathname === "/settings")
      await page.locator('a[href="/inbox/l1"]').first().click();
    await page.locator("button.message-row").first().waitFor();
  };
  await login();
  assert.notEqual(await page.locator("html").getAttribute("data-sent-replica"), "ready");
  console.log("PASS mailbox paints before background snapshot is ready");
  await page.waitForFunction(() => document.documentElement.dataset.sentReplica === "ready");
  await page.waitForFunction(() => document.documentElement.dataset.sentReplicaBodies === "ready");
  const initialStats = await page.evaluate(() => window.__replicaStats());
  assert.equal(initialStats.recentBodyCount, 1);
  assert.equal(initialStats.olderBodyCount, 0);
  assert(bodyRequests.length > 0);
  assert(bodyRequests.every((id) => id === recent.id));
  console.log("PASS recent bodies sync before open; all older rows remain body-free until opened");
  assert.equal(await page.locator("html").getAttribute("data-sent-replica-storage"), "opfs");
  const session = await page.locator("html").getAttribute("data-sent-replica-session");
  const start = requests.length;
  for (const view of ["l2", "l3", "all", "sent", "trash", "l1"]) {
    await page.locator(`a[href="/inbox/${view}"]`).first().click();
    await page.locator("button.message-row").first().waitFor();
  }
  assert.equal(requests.slice(start).filter((path) => path === "/api/messages").length, 0);
  console.log("PASS all mailbox views read SQLite without list requests");
  const thread = await page.locator("button.message-row").first().getAttribute("data-thread-id");
  await page.locator("button.message-row").first().click();
  await page.locator(".latest-message .email-body").waitFor();
  await page.waitForFunction(() => {
    const body = document.querySelector(".latest-message .email-body");
    return Boolean(body?.textContent?.trim()) && !body?.textContent?.includes("Loading message");
  });
  const text = await page.locator(".latest-message .email-body").innerText();
  await page.waitForLoadState("networkidle");
  assert((await page.evaluate(() => window.__replicaStats())).olderBodyCount > 0);
  assert(text.length > 20);
  assert(requests.some((path) => path === "/api/sync/bodies"));
  await context.setOffline(true);
  await page.locator('a[href="/inbox/all"]').first().click();
  await page.locator('a[href="/inbox/l1"]').first().click();
  await page.locator(`button.message-row[data-thread-id="${thread}"]`).click();
  assert.equal(await page.locator(".latest-message .email-body").innerText(), text);
  await page.screenshot({ path: join(output, "offline-local-reader.png"), fullPage: true });
  console.log("PASS bodies load lazily and cached reader/list work offline");
  await context.setOffline(false);
  await page
    .locator(".reader-toolbar")
    .getByRole("button", { name: "Archive conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator('a[href="/inbox/all"]').first().click();
  await page.locator('a[href="/inbox/l1"]').first().click();
  await page.locator(`button.message-row[data-thread-id="${thread}"]`).waitFor();
  console.log("PASS archive and undo persist through SQLite view changes");
  const account = (await db.query("select account_id from threads where id=$1", [thread])).rows[0]
      .account_id,
    newId = randomUUID();
  await db.query(
    "insert into messages(id,account_id,thread_id,provider_message_id,subject,text_body,received_at,direction) values($1::uuid,$2::uuid,$3::uuid,$1::uuid::text,'Replica new mail','New replica test body',now(),'inbound')",
    [newId, account, thread],
  );
  await page.getByRole("button", { name: /Replica new mail/ }).waitFor();
  await db.query("update messages set tombstone=true where id=$1", [newId]);
  await page.getByRole("button", { name: /Replica new mail/ }).waitFor({ state: "hidden" });
  console.log("PASS delta receives new mail and tombstones without mailbox refetches");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.sentReplica === "ready");
  assert.equal(await page.locator("html").getAttribute("data-sent-replica-session"), session);
  assert.equal(await page.locator("html").getAttribute("data-sent-replica-storage"), "opfs");
  console.log("PASS OPFS replica survives a document reload");
  await page.locator('a[href="/settings"]').first().click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  await page.waitForFunction(async (id) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(`.sent-mailbox-${id}`);
      return false;
    } catch {
      return true;
    }
  }, session);
  await login();
  await page.waitForFunction(() => document.documentElement.dataset.sentReplica === "ready");
  const second = await page.locator("html").getAttribute("data-sent-replica-session");
  assert.notEqual(second, session);
  await context.clearCookies();
  await page.evaluate(() => fetch("/api/accounts").then(() => {}));
  await page.getByLabel("Password").waitFor();
  await page.waitForFunction(async (id) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(`.sent-mailbox-${id}`);
      return false;
    } catch {
      return true;
    }
  }, second);
  assert.deepEqual(errors, []);
  console.log("PASS logout and API 401 wipe per-login databases; no browser errors");
  const memory = await browser.newContext({
    serviceWorkers: "block",
    storageState: await context.storageState(),
  });
  await memory.route("**/assets/replica-worker-*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `Object.defineProperty(navigator.storage,'getDirectory',{value:async()=>{throw new DOMException('Unavailable','SecurityError')}});${await response.text()}`,
    });
  });
  const memoryPage = await memory.newPage();
  await memoryPage.goto(`${url}/inbox/l1`);
  await memoryPage.getByLabel("Password").fill(password);
  await memoryPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await memoryPage.waitForFunction(() => document.documentElement.dataset.sentReplica === "ready");
  assert.equal(
    await memoryPage.locator("html").getAttribute("data-sent-replica-storage"),
    "memory",
  );
  await memoryPage.locator('a[href="/inbox/l2"]').first().click();
  await memoryPage.locator("button.message-row").first().waitFor();
  await memory.close();
  const network = await browser.newContext();
  await network.addInitScript(() => Object.defineProperty(window, "Worker", { value: undefined }));
  const networkPage = await network.newPage();
  await networkPage.goto(`${url}/inbox/l1`);
  await networkPage.getByLabel("Password").fill(password);
  await networkPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await networkPage.locator("button.message-row").first().waitFor();
  await networkPage.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/messages" && response.status() === 200,
  );
  assert.notEqual(await networkPage.locator("html").getAttribute("data-sent-replica"), "ready");
  await network.close();
  console.log(
    "PASS unavailable OPFS falls back to memory; unavailable workers retain network reads",
  );
  console.log(`Screenshot: ${join(output, "offline-local-reader.png")}`);
  await context.close();
} finally {
  await browser?.close();
  await db.end();
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGINT");
    await stopped;
  }
  log.end();
}
