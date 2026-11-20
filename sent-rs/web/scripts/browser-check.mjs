import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "package.json"));
const { hash } = require("argon2");
const { Client } = createRequire(join(root, "packages/core/package.json"))("pg");
const database = process.env.SENT_TEST_DATABASE_URL;
assert(database, "Set SENT_TEST_DATABASE_URL to a local sent_test_* database");
const url = new URL(database);
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert(/^\/sent_test_[a-zA-Z0-9_]+$/.test(url.pathname));
const password = "sent-solid-local-browser-password";
const env = {
  ...process.env,
  DATABASE_URL: database,
  SENT_FAKE_PROVIDERS: "true",
  OPENAI_API_KEY: "",
  SESSION_SECRET: "sent-solid-local-browser-session-secret",
  SENT_PASSWORD_HASH: await hash(password),
  HOST: "127.0.0.1",
  PORT: "3000",
  SENT_PUBLIC_URL: "http://localhost:3000",
};
delete env.WEB_DIST_PATH;
const screens = join(homedir(), "screens");
await mkdir(screens, { recursive: true });
const adminUrl = new URL(database);
adminUrl.pathname = "/sent";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const name = url.pathname.slice(1);
if (!(await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount)
  await admin.query(`create database "${name}"`);
await admin.end();
const seeded = spawnSync(join(root, "sent-rs/target/release/sent-seed"), ["--reset"], {
  cwd: root,
  env,
  encoding: "utf8",
});
assert.equal(seeded.status, 0, seeded.stderr);
console.log(seeded.stdout.trim());

const processes = [];
const start = (label, command, args) => {
  const output = createWriteStream(join(homedir(), `sent-stage3-${label}.log`));
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  processes.push(child);
};
const until = async (read, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await read()) return;
    } catch {
      /* The local processes may still be starting. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
};
const visible = async (locator) => locator.waitFor({ state: "visible", timeout: 20_000 });
const selected = (page) => new URL(page.url()).searchParams.get("message");
const contexts = [];
const errors = [];
let browser;
let solid;
try {
  start("browser-server", join(root, "sent-rs/target/release/sent-server"), []);
  start("browser-worker", join(root, "sent-rs/target/release/sent-worker"), []);
  start("react-preview", "pnpm", [
    "--filter",
    "@sent/web",
    "exec",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
  ]);
  await until(async () => {
    const health = await (await fetch("http://localhost:3000/api/health")).json();
    return health.status === "ok" && health.sync.fresh && health.workerHeartbeat;
  }, "Rust server/worker did not become healthy");
  await until(async () => (await fetch("http://localhost:4173")).ok, "React preview did not start");
  browser = await chromium.connectOverCDP("http://localhost:29229");
  const pages = [];
  for (const [label, base] of [
    ["solid", "http://localhost:3000"],
    ["react", "http://localhost:4173"],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
    });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
    await page.goto(base);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await visible(page.locator(".message-row").first());
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(screens, `${label}-inbox.png`), fullPage: true });
    pages.push(page);
    console.log(`PASS ${label} login and inbox screenshot`);
  }
  [solid] = pages;
  const inboxText = await pages[0].locator(".message-list").innerText();
  assert.equal(await pages[1].locator(".message-list").innerText(), inboxText);
  for (const page of pages) {
    await page.locator(".message-row").first().click();
    await visible(page.locator(".latest-message"));
  }
  for (const [index, page] of pages.entries()) {
    await until(
      async () =>
        !(await page.locator(".message-list").innerText()).includes("Syncing…") &&
        (await page.locator('.message-row[aria-current="true"]:not(.unread)').count()) === 1,
      "Conversation did not settle",
    );
    await page.screenshot({
      path: join(screens, `${index ? "react" : "solid"}-conversation.png`),
      fullPage: true,
    });
  }
  assert.equal(
    await pages[0].locator(".message-reader").innerText(),
    await pages[1].locator(".message-reader").innerText(),
  );
  console.log("PASS matching inbox/conversation copy; four comparison screenshots saved");

  const first = selected(solid);
  await solid.keyboard.press("j");
  await until(() => selected(solid) !== first, "j did not switch the open conversation");
  await visible(solid.locator(".latest-message"));
  const second = selected(solid);
  await solid.keyboard.press("k");
  await until(() => selected(solid) === first, "k did not restore the previous conversation");
  await visible(solid.locator(".latest-message"));
  console.log("PASS j/k focus and open-conversation navigation");

  const archivedSubject = await solid
    .locator('.message-row[aria-current="true"] .message-subject')
    .innerText();
  await solid.keyboard.press("e");
  await until(
    () => selected(solid) === second,
    "Archive did not auto-advance to the next conversation",
  );
  await visible(solid.getByRole("button", { name: "Undo", exact: true }));
  assert.equal(
    await solid.locator(".message-subject").filter({ hasText: archivedSubject }).count(),
    0,
  );
  await solid.getByRole("button", { name: "Undo", exact: true }).click();
  await until(() => selected(solid) === first, "Undo did not restore the archived conversation");
  await visible(solid.locator(".latest-message"));
  console.log("PASS e archive, conversation hiding, auto-advance and undo");

  for (const shortcut of ["Control+k", "Meta+k", "?"]) {
    await solid.keyboard.press(shortcut);
    await visible(solid.getByRole("dialog", { name: "Commands & shortcuts" }));
    await solid.keyboard.press("Escape");
    await solid.getByRole("dialog", { name: "Commands & shortcuts" }).waitFor({ state: "hidden" });
  }
  await solid.keyboard.press("Control+k");
  await solid.getByRole("button", { name: "Close command palette", exact: true }).focus();
  const beforeClose = solid.url();
  await solid.keyboard.press("Enter");
  await solid.getByRole("dialog", { name: "Commands & shortcuts" }).waitFor({ state: "hidden" });
  assert.equal(solid.url(), beforeClose);
  assert.equal(await solid.getByRole("dialog", { name: "Compose message" }).count(), 0);
  await solid.keyboard.press("Control+k");
  await solid.getByRole("combobox", { name: "Search commands" }).fill("Go to Updates");
  await solid.keyboard.press("Enter");
  await visible(solid.getByRole("heading", { name: "Updates", exact: true }));
  for (const [key, path] of [
    ["i", "l1"],
    ["u", "l2"],
    ["l", "l3"],
    ["a", "all"],
    ["s", "sent"],
    ["d", "drafts"],
    ["t", "trash"],
  ]) {
    await solid.keyboard.press("g");
    await solid.keyboard.press(key);
    await until(
      () => new URL(solid.url()).pathname === (path === "drafts" ? "/drafts" : `/inbox/${path}`),
      `g ${key} failed`,
    );
  }
  console.log("PASS Ctrl+K, Cmd+K, ?, palette execution and every g sequence");

  await solid.keyboard.press("/");
  const search = solid.getByRole("textbox", { name: "Search mail" });
  assert(await search.evaluate((element) => element === document.activeElement));
  const beforeTyping = solid.url();
  await search.pressSequentially("g i e # c");
  assert.equal(solid.url(), beforeTyping);
  await search.fill("deterministic");
  await search.press("Enter");
  await visible(solid.getByRole("heading", { name: "Search", exact: true }));
  await visible(solid.locator(".message-row").first());
  await search.press("Escape");
  await solid.keyboard.press("j");
  assert(
    await solid
      .locator(".message-row")
      .first()
      .evaluate((element) => element === document.activeElement),
  );
  await solid.keyboard.press("Enter");
  await visible(solid.locator(".latest-message"));
  console.log("PASS search, input shortcut guard, j focus and Enter open");

  await solid.getByRole("button", { name: "Reply all", exact: true }).click();
  await visible(solid.getByRole("dialog", { name: "Compose message" }));
  assert.match(await solid.locator("#compose-subject").inputValue(), /^Re:/);
  await solid.getByRole("button", { name: "Close composer" }).click();
  await solid.getByRole("button", { name: "Forward", exact: true }).click();
  assert.match(await solid.locator("#compose-subject").inputValue(), /^Fwd:/);
  await solid.getByRole("button", { name: "Close composer" }).click();
  await solid.keyboard.press("Escape");
  await solid.keyboard.press("c");
  await visible(solid.getByRole("dialog", { name: "Compose message" }));
  await solid.locator("#compose-to").fill("recipient@example.test");
  await solid.locator("#compose-subject").fill("SolidJS browser workflow");
  await solid.locator(".compose-body").fill("A local fake-provider browser check.");
  await solid.keyboard.press("Control+k");
  assert.equal(await solid.getByRole("dialog", { name: "Commands & shortcuts" }).count(), 0);
  await solid.locator('input[type="file"]').setInputFiles({
    name: "browser-check.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("fake-mail attachment"),
  });
  await visible(solid.locator(".file-chips"));
  assert.match(await solid.locator(".file-chips").innerText(), /browser-check\.txt/);
  await until(
    async () => (await solid.locator(".save-state").innerText()) === "Saved",
    "Compose autosave failed",
  );
  await solid.getByRole("button", { name: "Send", exact: true }).click();
  await solid.getByRole("dialog", { name: "Compose message" }).waitFor({ state: "hidden" });
  await solid.locator('.sidebar nav a[href="/inbox/sent"]').click();
  await visible(solid.locator(".message-subject").filter({ hasText: "SolidJS browser workflow" }));
  console.log(
    "PASS reply-all/forward seeds, compose autosave, attachment, shortcut pause and send → Sent",
  );
  await solid.locator('.sidebar a[href="/settings"]').click();
  await visible(solid.getByRole("button", { name: "Connect Gmail" }));
  await visible(solid.getByRole("button", { name: "Connect Microsoft" }));
  assert.equal(await solid.locator(".connected-account").count(), 2);
  assert.deepEqual(errors, []);
  console.log("PASS settings/accounts and zero browser errors");
  console.log(`SCREENSHOTS ${screens}/{react,solid}-{inbox,conversation}.png`);
} catch (error) {
  if (solid)
    await solid.screenshot({ path: join(screens, "solid-browser-failure.png"), fullPage: true });
  console.error("BROWSER_ERRORS", errors);
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser?.close();
  await Promise.all(
    processes.map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once("exit", done));
      process.kill(-child.pid, "SIGTERM");
      await exited;
    }),
  );
}
