import type { Page } from "playwright";

export async function prepareWarmMailbox(page: Page) {
  const timeout = 300_000;
  await prepareWarmReload(page, timeout);
  if (await page.locator("html").getAttribute("data-sent-replica")) {
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.sentReplica === "ready" &&
        document.documentElement.dataset.sentReplicaBodies !== "syncing",
      undefined,
      { timeout },
    );
    await page.waitForLoadState("networkidle", { timeout });
  }
}

export async function prepareWarmReload(page: Page, timeout = 30_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prepare(page, timeout),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Warm reload setup timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(page: Page, timeout: number) {
  await page.waitForLoadState("networkidle", { timeout });
  const state = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { registered: false, controlled: false };
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await navigator.serviceWorker.ready;
    return {
      registered: Boolean(registration),
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  });
  if (state.registered && !state.controlled) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout });
  }
}
