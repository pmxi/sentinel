import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import type { Selectors } from "./metrics.ts";

export function observeArchive(selectors: Selectors) {
  const snapshot = () => ({
    epoch: performance.timeOrigin + performance.now(),
    reader: document.querySelector(selectors.readerSubject)?.textContent,
    bodyLength: document.querySelector(selectors.body)?.textContent?.trim().length ?? 0,
    selected: document.querySelector(`${selectors.rows}[aria-current="true"]`)?.textContent,
    focus: document.activeElement?.outerHTML.slice(0, 500),
    subjects: [...document.querySelectorAll(selectors.rows)].map((row) =>
      row.querySelector(selectors.rowSubject)?.textContent?.trim(),
    ),
  });
  const history: unknown[] = [];
  let previous = "";
  const record = (event: string) => {
    const state = snapshot();
    const key = JSON.stringify([state.reader, state.subjects]);
    if (event === "mutation" && key === previous) return;
    previous = key;
    history.push({ event, ...state });
  };
  Object.assign(window, { __sentBenchDiagnostics: { history, snapshot } });
  document.addEventListener("keydown", (event) => record(`keydown:${event.key}`), true);
  new MutationObserver(() => record("mutation")).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

export async function installDiagnostics(page: Page, selectors: Selectors) {
  const network: unknown[] = [];
  const pending: Promise<void>[] = [];
  page.on("request", (request) =>
    network.push({
      event: "request",
      epoch: Date.now(),
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    }),
  );
  page.on("response", (response) => {
    const entry = {
      event: "response",
      epoch: Date.now(),
      status: response.status(),
      url: response.url(),
      payload: undefined as unknown,
    };
    network.push(entry);
    if (/\/api\/(messages|threads)/.test(response.url()) && response.request().method() === "GET") {
      pending.push(
        response
          .json()
          .then((body) => {
            entry.payload = body.messages
              ? body.messages.map(
                  (message: {
                    id: string;
                    threadId: string;
                    subject: string;
                    archived: boolean;
                    read: boolean;
                  }) => ({
                    id: message.id,
                    threadId: message.threadId,
                    subject: message.subject,
                    archived: message.archived,
                    read: message.read,
                  }),
                )
              : {
                  id: body.id,
                  threadId: body.threadId,
                  subject: body.subject,
                  archived: body.archived,
                  read: body.read,
                };
          })
          .catch(() => {}),
      );
    }
  });
  page.on("requestfinished", (request) =>
    network.push({
      event: "finished",
      epoch: Date.now(),
      method: request.method(),
      url: request.url(),
    }),
  );
  await page.addInitScript({
    content: `(() => { const __name = fn => fn; (${observeArchive.toString()})(${JSON.stringify(selectors)}); })();`,
  });
  return async (prefix: string) => {
    await page.screenshot({ path: `${prefix}.png`, fullPage: true });
    const dom = await page.evaluate(() => {
      const diagnostics = (
        window as unknown as { __sentBenchDiagnostics: { history: unknown[]; snapshot(): unknown } }
      ).__sentBenchDiagnostics;
      return {
        history: diagnostics.history,
        atTimeout: diagnostics.snapshot(),
        timing: window.__sentBench,
      };
    });
    await Promise.all(pending);
    await writeFile(`${prefix}.json`, `${JSON.stringify({ dom, network }, null, 2)}\n`);
  };
}
