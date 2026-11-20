import type { Page } from "playwright";

export async function prepareWarmReload(page: Page) {
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
