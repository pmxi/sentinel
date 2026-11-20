import type { Page, WebSocketRoute } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shapeLiveSocket, socketDelivery } from "../src/live-network.ts";

afterEach(() => vi.useRealTimers());
describe("live transport shaping", () => {
  it("adds half RTT per direction, preserving order without duplicating CDP bandwidth shaping", () => {
    expect(socketDelivery(0, 100, 20)).toBe(110);
    expect(socketDelivery(0, 0, 100)).toBe(50);
    expect(socketDelivery(200, 1, 100)).toBe(200);
    expect(socketDelivery(0, 10, 0)).toBe(10);
  });
  it("delays both real-server directions, records payload bytes and cancels pending page work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let fromClient!: (message: string | Buffer) => void,
      fromServer!: (message: string | Buffer) => void,
      close!: () => void;
    const server = {
      onMessage: (handler: typeof fromServer) => {
        fromServer = handler;
      },
      send: vi.fn(),
    };
    const client = {
      connectToServer: () => server,
      onMessage: (handler: typeof fromClient) => {
        fromClient = handler;
      },
      send: vi.fn(),
    };
    const page = {
      on: (_: string, handler: () => void) => {
        close = handler;
      },
      routeWebSocket: async (_: string, handler: (route: WebSocketRoute) => void) =>
        handler(client as unknown as WebSocketRoute),
    } as unknown as Page;
    const records = await shapeLiveSocket(page, "mobile", () => Date.now());
    fromServer("one");
    fromClient(Buffer.alloc(1000));
    expect(client.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(151);
    expect(client.send).toHaveBeenCalledWith("one");
    expect(server.send).toHaveBeenCalledOnce();
    expect(records.map((record) => record.bytes)).toEqual([3, 1000]);
    fromServer("cancelled");
    close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.send).toHaveBeenCalledOnce();
  });
});
