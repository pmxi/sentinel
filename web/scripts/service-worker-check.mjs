import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { writeShellWorker } from "../shell-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (password) =>
  execFileSync(join(root, "target/release/sent-hash-password"), [password]).toString().trim();
const require = createRequire(join(root, "web/package.json"));
const { Client } = require("pg");
const database = process.env.SENT_TEST_DATABASE_URL;
assert(database, "Set SENT_TEST_DATABASE_URL to a local sent_test_* database");
const db = new URL(database);
assert(["localhost", "127.0.0.1", "[::1]"].includes(db.hostname));
assert(/^\/sent_test_[a-zA-Z0-9_]+$/.test(db.pathname));
const adminUrl = new URL(database);
adminUrl.pathname = "/sent";
const admin = new Client({ connectionString: adminUrl.href });
await admin.connect();
if (
  !(await admin.query("select 1 from pg_database where datname=$1", [db.pathname.slice(1)]))
    .rowCount
)
  await admin.query(`create database "${db.pathname.slice(1)}"`);
await admin.end();
const output = join(homedir(), "sw-shell-check", `${Date.now()}`);
await mkdir(output, { recursive: true });
const active = join(output, "active");
const next = join(output, "next");
await cp(join(root, "web/dist"), active, { recursive: true });
await cp(active, next, { recursive: true });
await writeFile(
  join(next, "index.html"),
  (await readFile(join(next, "index.html"), "utf8")).replace(
    "</head>",
    '<meta name="sent-build-check" content="b"></head>',
  ),
);
await writeShellWorker(
  next,
  (await readdir(next, { recursive: true })).filter((name) => !/\.(br|gz)$/.test(name)),
);
for (const name of ["index.html", "sw.js"]) {
  const bytes = await readFile(join(next, name));
  await writeFile(join(next, `${name}.br`), brotliCompressSync(bytes));
  await writeFile(join(next, `${name}.gz`), gzipSync(bytes));
}
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const url = `http://localhost:${port}`;
const password = "sent-sw-local-test-password";
const env = {
  ...process.env,
  DATABASE_URL: database,
  SENT_FAKE_PROVIDERS: "true",
  OPENAI_API_KEY: "",
  SESSION_SECRET: "sent-sw-local-test-session-secret",
  SENT_PASSWORD_HASH: hash(password),
  HOST: "127.0.0.1",
  PORT: String(port),
  SENT_PUBLIC_URL: url,
  WEB_DIST_PATH: active,
};
const seed = spawnSync(join(root, "target/release/sent-seed"), ["--reset"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(seed.status, 0, seed.stderr);
const log = createWriteStream(join(output, "server.log"));
const server = spawn(join(root, "target/release/sent-server"), [], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    assert.equal(server.exitCode, null, "Server exited");
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    assert(attempt < 100, "Server did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.SENT_CHROMIUM_PATH ?? require("playwright-core").chromium.executablePath(),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/inbox`);
  const signIn = async () => {
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".app-shell").waitFor();
    if (new URL(page.url()).pathname === "/settings")
      await page.locator('a[href="/inbox"]').click();
    await page.locator("button.message-row").first().waitFor();
  };
  await signIn();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((done) =>
        navigator.serviceWorker.addEventListener("controllerchange", done, { once: true }),
      );
  });
  const keys = () =>
    page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith("sent-shell-")),
    );
  const first = await keys();
  assert.equal(first.length, 1);
  for (const path of ["/index.html", "/inbox/all"])
    assert.equal(
      (await context.request.get(`${url}${path}`)).headers()["cache-control"],
      "no-cache",
    );
  assert.equal((await context.request.get(`${url}/sw.js`)).headers()["cache-control"], "no-store");
  console.log("PASS initial precache, network HTML no-cache and worker no-store headers");
  await context.setOffline(true);
  const offlineResponse = await page.reload({ waitUntil: "domcontentloaded" });
  assert(offlineResponse.fromServiceWorker());
  await page.locator(".app-shell").waitFor();
  await page.getByRole("status").filter({ hasText: "Offline." }).waitFor();
  assert(await page.getByRole("textbox", { name: "Search mail" }).isVisible());
  assert(
    await page.evaluate(async () => {
      try {
        await fetch("/api/auth/session");
        return false;
      } catch {
        return true;
      }
    }),
  );
  await page.screenshot({ path: join(output, "offline-shell.png"), fullPage: true });
  console.log("PASS offline reload renders the shell; APIs remain network-only");
  await context.setOffline(false);
  await page.locator("button.message-row").first().waitFor();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "Compose message" });
  await composer.getByPlaceholder("Subject", { exact: true }).fill("Update-safe composition");
  await composer.getByPlaceholder("Message", { exact: true }).fill("Pending draft text");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "keep.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keep this attachment"),
  });
  await composer.locator(".file-chips").getByText("keep.txt").waitFor();
  await page.evaluate(() => {
    window.__beforeUpdateController = navigator.serviceWorker.controller;
  });
  await rename(active, join(output, "previous"));
  await rename(next, active);
  await page
    .evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update();
    })
    .catch((error) => {
      if (!error.message.includes("Execution context was destroyed")) throw error;
    });
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== window.__beforeUpdateController,
  );
  assert(await composer.isVisible());
  assert(await composer.locator(".file-chips").getByText("keep.txt").isVisible());
  assert.equal(await page.locator('meta[name="sent-build-check"]').count(), 0);
  await composer.getByPlaceholder("Message", { exact: true }).fill("Latest text just before close");
  const navigation = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await composer.getByRole("button", { name: "Close composer" }).click();
  await navigation;
  await page.locator('meta[name="sent-build-check"][content="b"]').waitFor({ state: "attached" });
  await page.locator("button.message-row").first().waitFor();
  const second = await keys();
  assert.equal(second.length, 1);
  assert.notEqual(second[0], first[0]);
  console.log("PASS new build activates, reloads the controlled tab and removes the old cache");
  const restored = await context.request.get(`${url}/api/drafts`);
  const savedDraft = (await restored.json()).drafts.find(
    (draft) => draft.subject === "Update-safe composition",
  );
  assert(savedDraft);
  assert.equal(savedDraft.body, "Latest text just before close");
  console.log(
    "PASS update retains open composer attachments and flushes pending text before deferred reload",
  );
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await composer.getByPlaceholder("Subject", { exact: true }).fill("Abandoned session draft");
  await composer
    .getByPlaceholder("Message", { exact: true })
    .fill("Unsaved text at session expiry");
  await context.clearCookies();
  await page.getByLabel("Password").waitFor();
  assert.equal(await composer.count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("sent:shell:v1")), null);
  console.log("PASS a live API 401 revokes cached shell metadata and shows login");
  await page.waitForLoadState("networkidle");
  await signIn();
  const third = join(output, "third");
  await cp(active, third, { recursive: true });
  await writeFile(
    join(third, "index.html"),
    (await readFile(join(third, "index.html"), "utf8")).replace('content="b"', 'content="c"'),
  );
  await writeShellWorker(
    third,
    (await readdir(third, { recursive: true })).filter((name) => !/\.(br|gz)$/.test(name)),
  );
  for (const name of ["index.html", "sw.js"]) {
    const bytes = await readFile(join(third, name));
    await writeFile(join(third, `${name}.br`), brotliCompressSync(bytes));
    await writeFile(join(third, `${name}.gz`), gzipSync(bytes));
  }
  await rename(active, join(output, "build-b"));
  await rename(third, active);
  const reloggedNavigation = page.waitForEvent(
    "framenavigated",
    (frame) => frame === page.mainFrame(),
  );
  await page
    .evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update();
    })
    .catch((error) => {
      if (!error.message.includes("Execution context was destroyed")) throw error;
    });
  await reloggedNavigation.catch(async (error) => {
    console.error(
      "Post-login update diagnostics",
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return {
          caches: await caches.keys(),
          active: registration?.active?.state,
          waiting: registration?.waiting?.state,
          installing: registration?.installing?.state,
          controller: navigator.serviceWorker.controller?.state,
          build: document.querySelector('meta[name="sent-build-check"]')?.outerHTML,
          dialogs: document.querySelectorAll(".composer").length,
          worker: (await (await fetch("/sw.js", { cache: "reload" })).text()).slice(0, 130),
        };
      }),
    );
    throw error;
  });
  await page.locator('meta[name="sent-build-check"][content="c"]').waitFor({ state: "attached" });
  await page.locator("button.message-row").first().waitFor();
  console.log("PASS expired-session composer unmounts and cannot block a later build after login");
  await page.locator('a[href="/settings"]').click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("sent:shell:v1")), null);
  await signIn();
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (
          await caches.keys()
        ).map(async (name) =>
          (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname),
        ),
      )
    ).flat(),
  );
  assert(
    cached.length >= 3 &&
      cached.every((path) => path === "/index.html" || path.startsWith("/assets/")),
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, "updated-authenticated-shell.png"), fullPage: true });
  console.log("PASS logout/login, static-only cache contents and no browser errors");
  console.log(`Screenshots: ${output}/offline-shell.png ${output}/updated-authenticated-shell.png`);
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const ended = once(server, "exit");
    server.kill("SIGINT");
    await ended;
  }
  log.end();
}
