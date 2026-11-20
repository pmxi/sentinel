import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BrowserContext, chromium, type Page } from "playwright";
import { ensureArchiveCapacity, sampleRowIndex } from "./archive.ts";
import { SEARCH_TERMS } from "./data.ts";
import { installDiagnostics } from "./diagnostics.ts";
import {
  ACTIONS,
  DEFAULT_SELECTORS,
  PROFILES,
  type Profile,
  type Results,
  type Sample,
  summary,
} from "./metrics.ts";
import { trackNetwork } from "./network.ts";
import { type Condition, installPaintObserver } from "./paint.ts";
import { prepareRows } from "./rows.ts";
import { prepareWarmReload } from "./warm.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    password: { type: "string" },
    label: { type: "string", default: "build" },
    profiles: { type: "string", default: Object.keys(PROFILES).join(",") },
    iterations: { type: "string", default: "15" },
    selectors: { type: "string" },
    out: { type: "string" },
    actions: { type: "string", default: ACTIONS.join(",") },
    diagnostics: { type: "boolean", default: false },
  },
});
if (!values.url) throw new Error("--url is required");
const url = new URL(values.url);
if (!["http:", "https:"].includes(url.protocol)) throw new Error("--url must use HTTP(S)");
const password = values.password ?? process.env.SENT_BENCH_PASSWORD;
if (!password) throw new Error("--password or SENT_BENCH_PASSWORD is required");
const iterations = Number(values.iterations);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100)
  throw new Error("--iterations must be 1..100 (archive safety bound)");
const profiles = [...new Set(values.profiles.split(","))];
const actions = [...new Set(values.actions.split(","))];
if (actions.some((action) => !ACTIONS.some((known) => known === action)))
  throw new Error("Unknown action");
if (!profiles.length || profiles.some((p) => !(p in PROFILES)))
  throw new Error("Unknown network profile");
const selectors = { ...DEFAULT_SELECTORS };
if (values.selectors) {
  const overrides: unknown = JSON.parse(await readFile(values.selectors, "utf8"));
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("Selectors must be a JSON object");
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in selectors) || typeof value !== "string" || !value.trim())
      throw new Error(`Invalid selector/key override: ${key}`);
    Object.assign(selectors, { [key]: value });
  }
}
const date = new Date().toISOString();
const label = values.label;
const out = resolve(
  values.out ??
    `bench/results/${label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${date.replaceAll(":", "-")}`,
);
await mkdir(out, { recursive: true });
const timeout = 30000;
console.log(
  "Archive mutates data: reseed the benchmark DB before EACH full run. Never target production. Archive is bounded to 102 actions per profile (including warmups).",
);
const browser = await chromium.launch({ headless: true });
let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
try {
  const auth = await browser.newContext();
  try {
    const response = await auth.request.post(new URL("/api/auth/login", url).href, {
      headers: { "x-sent-request": "1" },
      data: { password },
      timeout,
    });
    if (!response.ok()) throw new Error(`Login HTTP ${response.status()}`);
    if (actions.includes("archive"))
      await ensureArchiveCapacity(
        auth.request,
        url,
        iterations,
        profiles.length,
        actions.includes("next_email"),
      );
    storageState = await auth.storageState();
  } finally {
    await auth.close();
  }
} catch (error) {
  await browser.close();
  throw error;
}
const results: Results = {
  metadata: {
    url: url.href,
    label,
    date,
    chromium: browser.version(),
    host: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      ramBytes: totalmem(),
      os: `${platform()} ${release()}`,
    },
    profiles: Object.fromEntries(profiles.map((p) => [p, PROFILES[p as Profile]])),
    iterations,
    warmups: 2,
    selectors,
    timeoutMs: timeout,
    actions,
    diagnostics: values.diagnostics,
  },
  samples: [],
  failures: [],
};
const save = async () => {
  await writeFile(resolve(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(resolve(out, "summary.md"), summary(results));
};
const waitPaint = async (page: Page) => {
  await page.waitForFunction(
    () => window.__sentBench?.result !== null && window.__sentBench?.result !== undefined,
    undefined,
    { timeout },
  );
  return page.evaluate(() => window.__sentBench.result as number);
};
const arm = (page: Page, condition: Condition, type: "click" | "keydown", key?: string) =>
  page.evaluate(({ condition, type, key }) => window.__sentBench.arm(condition, { type, key }), {
    condition,
    type,
    key,
  });
const normalize = (s: string) => s.trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, "");
const open = async (page: Page, index: number) => {
  const { row } = await prepareRows(page, selectors.rows, index);
  const subject = normalize(await row.locator(selectors.rowSubject).innerText());
  await arm(page, { kind: "reader", subject }, "click");
  await row.click();
  const ms = await waitPaint(page);
  return { subject, ms };
};
const newPage = async (context: BrowserContext, profile: Profile) => {
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...PROFILES[profile] });
  // tsx preserves nested function names with an injected __name helper.
  await page.addInitScript({
    content: `(() => { const __name = (fn) => fn; (${installPaintObserver.toString()})(${JSON.stringify(selectors)}); })();`,
  });
  return page;
};
try {
  for (const profile of profiles as Profile[]) {
    for (const action of ACTIONS.filter((action) => actions.includes(action))) {
      for (let iteration = -2; iteration < iterations; iteration++) {
        const sample: Sample = {
          profile,
          action,
          iteration,
          warmup: iteration < 0,
          ms: null,
          requests: null,
          transferredBytes: null,
        };
        let context: BrowserContext | undefined;
        let capture: ((prefix: string) => Promise<void>) | undefined;
        try {
          context = await browser.newContext({
            storageState,
            viewport: { width: 1440, height: 1000 },
            serviceWorkers: action === "warm_reload" ? "allow" : "block",
          });
          const page = await newPage(context, profile);
          if (values.diagnostics) capture = await installDiagnostics(page, selectors);
          const network = trackNetwork(page);
          await page.goto(url.href, { waitUntil: "domcontentloaded" });
          const initial = await waitPaint(page);
          const index = sampleRowIndex(iteration);
          if (action === "cold_start") sample.ms = initial;
          else if (action === "inbox_load") {
            await page.reload({ waitUntil: "domcontentloaded" });
            sample.ms = await waitPaint(page);
          } else if (action === "warm_reload") {
            await prepareWarmReload(page);
            const response = await page.reload({ waitUntil: "domcontentloaded" });
            sample.ms = await waitPaint(page);
            sample.serviceWorker = response?.fromServiceWorker() ?? false;
          } else if (action === "open_email") sample.ms = (await open(page, index)).ms;
          else if (action === "next_email") {
            const current = await open(page, index);
            const { next } = await prepareRows(page, selectors.rows, index, true);
            const subject = normalize(await next.locator(selectors.rowSubject).innerText());
            if (subject === current.subject) throw new Error("Next row subject is not distinct");
            await arm(page, { kind: "reader", subject }, "keydown", selectors.nextKey);
            await page.keyboard.press(selectors.nextKey);
            sample.ms = await waitPaint(page);
          } else if (action === "archive") {
            const { subject } = await open(page, index);
            await arm(page, { kind: "archive", subject }, "keydown", selectors.archiveKey);
            await page.keyboard.press(selectors.archiveKey);
            sample.ms = await waitPaint(page);
          } else {
            const term = action === "search_rare" ? SEARCH_TERMS.rare : SEARCH_TERMS.common;
            const before = await page.locator(selectors.rows).first().innerText();
            await page.keyboard.press(selectors.searchKey);
            await page.locator(selectors.search).fill(term);
            await arm(page, { kind: "search", term, before }, "keydown", selectors.submitKey);
            await page.locator(selectors.search).press(selectors.submitKey);
            sample.ms = await waitPaint(page);
          }
          Object.assign(sample, await network());
        } catch (error) {
          sample.error = (error instanceof Error ? error.message : String(error)).replaceAll(
            password,
            "[redacted]",
          );
          results.failures.push(sample);
          if (capture) {
            const prefix = resolve(out, `${profile}-${action}-${iteration}`);
            try {
              await capture(prefix);
              sample.evidence = `${profile}-${action}-${iteration}`;
            } catch (captureError) {
              console.error(`Diagnostic capture failed: ${String(captureError)}`);
            }
          }
          console.error(`${profile}/${action}/${iteration}: ${sample.error}`);
        } finally {
          await context?.close();
        }
        results.samples.push(sample);
      }
      await save();
      console.log(`${profile}/${action} complete`);
    }
  }
} finally {
  await save();
  await browser.close();
}
console.log(summary(results));
console.log(`Saved ${out}`);
if (results.failures.length) process.exitCode = 1;
