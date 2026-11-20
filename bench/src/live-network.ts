import type { Page } from "playwright";
import { PROFILES, type Profile } from "./metrics.ts";
import { epochNow } from "./new-mail.ts";

export type SocketTransfer = { epoch: number; bytes: number };
export function socketDelivery(previous: number, now: number, latency: number) {
  return Math.max(previous, now + latency / 2);
}

export async function shapeLiveSocket(page: Page, profile: Profile, now = epochNow) {
  const transfers: SocketTransfer[] = [],
    timers = new Set<ReturnType<typeof setTimeout>>();
  page.on("close", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
  await page.routeWebSocket("**/api/live", (client) => {
    const server = client.connectToServer();
    const forward = (send: (message: string | Buffer) => void) => {
      let next = 0;
      return (message: string | Buffer) => {
        const received = now(),
          bytes = Buffer.byteLength(message);
        next = socketDelivery(next, received, PROFILES[profile].latency);
        const deliver = () => {
          transfers.push({ epoch: now(), bytes });
          send(message);
        };
        if (next <= received) deliver();
        else {
          const timer = setTimeout(() => {
            timers.delete(timer);
            deliver();
          }, next - received);
          timers.add(timer);
        }
      };
    };
    client.onMessage(forward((message) => server.send(message)));
    server.onMessage(forward((message) => client.send(message)));
  });
  return transfers;
}
