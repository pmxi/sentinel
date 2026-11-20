import type { Page } from "playwright";

export async function prepareWarmReload(page: Page) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prepare(page),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Warm reload setup timed out after 30000ms")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(page: Page) {
  await page.waitForLoadState("networkidle");
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
    await page.waitForLoadState("networkidle");
  }
}
