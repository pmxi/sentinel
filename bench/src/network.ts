import type { Page, Request } from "playwright";

export type Transfer = { start: number; end?: number; bytes?: number };
export function networkTotals(records: Transfer[], start: number, end: number) {
  const triggered = records.filter((record) => record.start >= start && record.start <= end);
  return {
    requests: triggered.length,
    transferredBytes: triggered.reduce(
      (sum, record) =>
        sum + (record.end !== undefined && record.end <= end ? (record.bytes ?? 0) : 0),
      0,
    ),
  };
}

export function trackNetwork(page: Page) {
  const records = new Map<Request, Transfer>();
  const pending: Promise<void>[] = [];
  page.on("request", (request) => records.set(request, { start: request.timing().startTime }));
  page.on("response", (response) => {
    const request = response.request();
    const record = records.get(request);
    if (!record) return;
    record.start = request.timing().startTime;
  });
  page.on("requestfinished", (request) => {
    const record = records.get(request);
    if (!record) return;
    const timing = request.timing();
    record.end = timing.startTime + timing.responseEnd;
    pending.push(
      request
        .sizes()
        .then((sizes) => {
          record.bytes =
            sizes.requestHeadersSize +
            sizes.requestBodySize +
            sizes.responseHeadersSize +
            sizes.responseBodySize;
        })
        .catch(() => {}),
    );
  });
  return async () => {
    const boundary = await page.evaluate(() => ({
      start: window.__sentBench.startEpoch,
      end: window.__sentBench.endEpoch,
    }));
    await Promise.all(pending);
    if (boundary.start === null || boundary.end === null)
      return { requests: null, transferredBytes: null };
    return networkTotals([...records.values()], boundary.start, boundary.end);
  };
}
