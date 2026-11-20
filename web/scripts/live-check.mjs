import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { TestDatabase } from "./sqlite-test-db.mjs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).stdout.trim();
const rust = root;
const database = process.env.SENT_TEST_DATABASE_PATH;
const db = new TestDatabase(database);
const output = join(homedir(), "live-check", String(Date.now()));
await mkdir(output, { recursive: true });
const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const url = `http://127.0.0.1:${port}`,
  password = "sent-live-local-test-password";
const secret = "sent-live-local-test-session-secret-123";
const env = {
  ...process.env,
  SENT_DATABASE_PATH: database,
  SENT_FAKE_PROVIDERS: "true",
  OPENAI_API_KEY: "",
  SESSION_SECRET: secret,
  SENT_PASSWORD_HASH: execFileSync(join(root, "target/release/sent-hash-password"), [password])
    .toString()
    .trim(),
  HOST: "127.0.0.1",
  PORT: String(port),
  SENT_PUBLIC_URL: url,
  WEB_DIST_PATH: join(rust, "web/dist"),
};
const seed = spawnSync(join(rust, "target/release/sent-seed"), ["--reset", "--messages", "3000"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(seed.status, 0, seed.stderr);
const log = createWriteStream(join(output, "server.log"));
const server = spawn(join(rust, "target/release/sent-server"), [], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
await db.connect();
const { id: account, email } = (await db.query("select id,email from accounts order by id limit 1"))
  .rows[0];
async function insert(prefix = "Live mail") {
  const id = randomUUID(),
    thread = randomUUID(),
    subject = `${prefix} ${id}`;
  await db.query("begin");
  try {
    const date = (
      await db.query(
        "select max(strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ',max(received_at),'+1 second')) as date from messages",
      )
    ).rows[0].date;
    await db.query(
      "insert into threads(id,account_id,provider_thread_id,subject,last_message_at) values($1,$2,$3,$4,$5)",
      [thread, account, `live-${thread}`, subject, date],
    );
    await db.query(
      "insert into messages(id,account_id,thread_id,provider_message_id,subject,from_addresses,to_addresses,snippet,text_body,received_at,direction) values($1,$2,$3,$4,$5,$6,$7,'Pushed without reload','Live test body',$8,'inbound')",
      [
        id,
        account,
        thread,
        `live-${id}`,
        subject,
        JSON.stringify([{ name: "Live sender", address: "live@example.test" }]),
        JSON.stringify([{ address: email }]),
        date,
      ],
    );
    await db.query(
      "insert into classifications(message_id,model_tier,reasoning,model,prompt_version) values($1,1,'Live test','fake','fake')",
      [id],
    );
    await db.signal([id]);
    await db.query("commit");
    return subject;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
const errors = [];
let browser, proxy;
try {
  for (let attempt = 0; ; attempt++) {
    assert.equal(server.exitCode, null);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    assert(attempt < 100, "Server did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SENT_CHROMIUM_PATH,
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  const login = async (context) =>
    assert(
      (
        await context.request.post(`${url}/api/auth/login`, {
          headers: { "x-sent-request": "1" },
          data: { password },
        })
      ).ok(),
    );
  await login(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const frames = [],
    sockets = [];
  let deltaRequests = 0,
    navigations = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/sync/delta")) deltaRequests++;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on("websocket", (socket) => {
    sockets.push(socket);
    socket.on("framereceived", ({ payload }) => {
      try {
        frames.push(JSON.parse(String(payload)));
      } catch {}
    });
  });
  await page.goto(`${url}/inbox`);
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.sentReplica === "ready" &&
      document.documentElement.dataset.sentLive === "ready",
  );
  await page.waitForLoadState("networkidle");
  const before = deltaRequests,
    originalNavigations = navigations;
  const insertedAt = performance.now();
  const subject = await insert();
  const row = (page, subject) => page.locator("button.message-row").filter({ hasText: subject });
  await row(page, subject).waitFor({ state: "visible", timeout: 10_000 });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const latency = performance.now() - insertedAt;
  assert(latency < 1000, `New mail took ${latency.toFixed(1)} ms to paint`);
  assert.equal(await row(page, subject).count(), 1);
  assert.equal(deltaRequests, before, "A small pushed delta should not require HTTP catch-up");
  await page.screenshot({ path: join(output, "new-mail-pushed.png") });
  console.log(
    `PASS new mail paints in ${latency.toFixed(1)} ms without reload or HTTP delta request (under 1 s)`,
  );
  const other = await context.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  await other.goto(`${url}/inbox`);
  await other.waitForFunction(
    () =>
      document.documentElement.dataset.sentReplica === "ready" &&
      document.documentElement.dataset.sentLive === "ready",
  );
  await row(other, subject).click();
  await other.locator(".conversation-heading h2").filter({ hasText: subject }).waitFor();
  await other.keyboard.press("e");
  await row(page, subject).waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(navigations, originalNavigations);
  await page.screenshot({ path: join(output, "archive-from-other-tab.png") });
  console.log("PASS archive in another tab propagates without navigation");
  const subjects = [];
  for (let index = 0; index < 3; index++) subjects.push(await insert("Live burst"));
  for (const subject of subjects) await row(page, subject).waitFor({ state: "visible" });
  assert.equal(
    frames.filter(
      (frame) =>
        frame.type === "delta" &&
        frame.delta.upserts.some((row) => row.subject.startsWith("Live burst")),
    ).length,
    1,
  );
  for (let index = 0; index < 3; index++)
    await db.signal(subjects.map((subject) => subject.slice(-36)));
  await page.waitForLoadState("networkidle");
  for (const subject of subjects) assert.equal(await row(page, subject).count(), 1);
  console.log("PASS bursts coalesce and repeated notifications never duplicate rows");
  const upgrades = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
  };
  assert.equal(
    (
      await context.request.get(`${url}/api/live`, {
        headers: { ...upgrades, origin: "https://foreign.invalid" },
      })
    ).status(),
    403,
  );
  assert.equal((await context.request.get(`${url}/api/live`, { headers: upgrades })).status(), 403);
  const anonymous = await browser.newContext();
  assert.equal(
    (
      await anonymous.request.get(`${url}/api/live`, { headers: { ...upgrades, origin: url } })
    ).status(),
    401,
  );
  const token = (await context.cookies()).find((cookie) => cookie.name === "sent_session").value;
  assert.equal(
    (
      await anonymous.request.get(`${url}/api/live`, {
        headers: { ...upgrades, origin: url, authorization: `Bearer ${token}` },
      })
    ).status(),
    401,
  );
  await anonymous.close();
  console.log("PASS live upgrade requires a valid session cookie and exact configured Origin");
  const capped = await page.evaluate(async () => {
    const all = Array.from(
      { length: 9 },
      () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`),
    );
    const results = await Promise.all(
      all.map(
        (socket) =>
          new Promise((done) => {
            socket.onopen = () => done("open");
            socket.onerror = () => done("rejected");
          }),
      ),
    );
    for (const socket of all) socket.close();
    return results;
  });
  assert.equal(capped.filter((result) => result === "open").length, 6);
  console.log("PASS eight-socket session cap rejects additional connections");
  await context.setOffline(true);
  await page.waitForFunction(() => document.documentElement.dataset.sentLive === "polling");
  const offline = await insert("Live reconnect");
  assert.equal(await row(page, offline).count(), 0);
  await context.setOffline(false);
  await row(page, offline).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.documentElement.dataset.sentLive === "ready");
  console.log("PASS offline/online reconnect catches missed changes");
  await db.query("alter table worker_state rename to worker_state_live_hold");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.sentLive === "polling");
  } finally {
    await db.query("alter table worker_state_live_hold rename to worker_state");
  }
  await page.waitForFunction(
    () => document.documentElement.dataset.sentLive === "ready",
    undefined,
    { timeout: 15_000 },
  );
  const recovered = await insert("Live listener recovered");
  await row(page, recovered).waitFor({ state: "visible" });
  console.log("PASS dedicated data_version observer reconnects after a SQLite query failure");
  let deliverLogout;
  const released = new Promise((done) => {
    deliverLogout = done;
  });
  await context.route("**/api/auth/logout", async (route) => {
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });
  await page.locator('a[href="/settings"]').first().click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  let reloaded;
  try {
    await other.getByLabel("Password").waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.sentLive !== "ready");
    assert.equal(
      await page.getByLabel("Password").isVisible(),
      false,
      "Local sign-out must finish its HTTP response before offering a new login",
    );
    reloaded = page.waitForEvent("load");
  } finally {
    deliverLogout();
  }
  await reloaded;
  await page.getByLabel("Password").waitFor();
  await other.getByLabel("Password").waitFor();
  assert(sockets.every((socket) => socket.isClosed()));
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".app-shell").waitFor();
  await context.close();
  console.log("PASS logout closes the session's sockets in all tabs");
  const network = await browser.newContext({ serviceWorkers: "block" });
  await network.addInitScript(() => {
    window.Worker = undefined;
  });
  await login(network);
  const networkPage = await network.newPage();
  networkPage.on("pageerror", (error) => errors.push(error.message));
  await networkPage.goto(`${url}/inbox`);
  await networkPage.waitForFunction(() => document.documentElement.dataset.sentLive === "ready");
  await networkPage.waitForLoadState("networkidle");
  const networkMail = await insert("Live network fallback");
  await row(networkPage, networkMail).waitFor({ state: "visible", timeout: 2500 });
  await network.close();
  console.log("PASS push invalidates queries when SQLite workers are unavailable");
  const expiring = await browser.newContext({ serviceWorkers: "block" });
  await expiring.addInitScript(() => {
    window.Worker = undefined;
  });
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ iss: "sent", sub: "owner", role: "owner", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 5, jti: randomUUID() })}`;
  const expiringToken = `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
  await expiring.addCookies([{ url, name: "sent_session", value: expiringToken }]);
  const expiringPage = await expiring.newPage();
  await expiringPage.goto(`${url}/inbox`);
  await expiringPage.waitForFunction(() => document.documentElement.dataset.sentLive === "ready");
  await expiringPage.getByLabel("Password").waitFor({ timeout: 10_000 });
  await expiring.close();
  console.log("PASS session expiry closes the socket and returns to sign-in");
  proxy = httpServer((incoming, response) => {
    const upstream = request(
      `${url}${incoming.url}`,
      { method: incoming.method, headers: incoming.headers },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    incoming.pipe(upstream);
  });
  proxy.on("upgrade", (incoming, socket) => {
    const headers = { ...incoming.headers, connection: "close" };
    delete headers.upgrade;
    const upstream = request(`${url}${incoming.url}`, { headers }, (response) => {
      response.resume();
      socket.end(
        `HTTP/1.1 ${response.statusCode} Upgrade not forwarded\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const fallback = await browser.newContext({ serviceWorkers: "block" });
  await login(fallback);
  const fallbackPage = await fallback.newPage();
  fallbackPage.on("pageerror", (error) => errors.push(error.message));
  await fallbackPage.goto(`${proxyUrl}/inbox`);
  await fallbackPage.waitForFunction(
    () => document.documentElement.dataset.sentReplica === "ready",
  );
  assert.equal(await fallbackPage.locator("html").getAttribute("data-sent-live"), "polling");
  const blocked = await insert("Live blocked Upgrade");
  await row(fallbackPage, blocked).waitFor({ state: "visible", timeout: 6500 });
  assert.equal(await fallbackPage.locator(".fatal-error").count(), 0);
  await fallback.close();
  console.log("PASS a plain proxy stripping Upgrade retains four-second polling with no UI error");
  assert.deepEqual(errors, []);
  console.log(`Evidence ${output}`);
} finally {
  await browser?.close();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
  }
  await db.end();
  if (server.exitCode === null) {
    const exit = once(server, "exit");
    server.kill("SIGINT");
    await exit;
  }
  log.end();
}
