import { QueryClient } from "@tanstack/solid-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveUpdates, liveHealthy, liveInterval } from "./live";
import { REPLICA_RESET_EVENT } from "./replica-session";
import { UNAUTHORIZED_EVENT } from "./shell-metadata";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number }) => void;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  message(value: unknown) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  end(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const active: LiveUpdates[] = [];
function setup(cursor?: string) {
  const client = new QueryClient();
  const options = { verified: () => true, cursor: () => cursor, changed: vi.fn(), wake: vi.fn() };
  const live = new LiveUpdates(client, options);
  active.push(live);
  return { client, options, live };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  Socket.instances = [];
});
afterEach(() => {
  for (const live of active.splice(0)) live.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("live updates", () => {
  it("does not loop catch-up and subscriptions when HTTP and sockets use different cursors", async () => {
    const { options, live } = setup("http-0");
    let polls = 0;
    options.changed.mockImplementation(() => {
      polls++;
    });
    options.cursor = () => `http-${polls}`;
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0];
    const send = socket.send.bind(socket);
    let replies = 0;
    let serverCursor = "socket-cursor";
    vi.spyOn(socket, "send").mockImplementation((value) => {
      send(value);
      if (JSON.parse(value).type === "subscribe" && replies++ < 10) {
        setTimeout(() => socket.message({ type: "changed", cursor: serverCursor }), 1);
      }
    });
    socket.message({ type: "ready" });
    await vi.advanceTimersByTimeAsync(50);
    expect(polls).toBeLessThanOrEqual(2);
    expect(socket.sent.length).toBeLessThanOrEqual(3);
    const settled = polls;
    const subscriptions = socket.sent.length;
    live.subscribe();
    live.subscribe();
    expect(socket.sent.length).toBe(subscriptions);
    socket.message({ type: "changed", cursor: "socket-cursor" });
    await vi.advanceTimersByTimeAsync(50);
    expect(polls).toBe(settled);
    serverCursor = "real-next-change";
    socket.message({ type: "changed", cursor: serverCursor });
    await vi.advanceTimersByTimeAsync(50);
    expect(polls).toBe(settled + 1);
  });
  it("uses a cookie-authenticated same-origin URL and only slows polling after ready", async () => {
    const { client, options } = setup("base");
    expect(liveInterval(client)).toBe(4000);
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0];
    expect(socket.url.pathname).toBe("/api/live");
    expect(socket.url.search).toBe("");
    expect(liveHealthy(client)).toBe(false);
    socket.message({ type: "ready" });
    expect(liveInterval(client)).toBe(60_000);
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "subscribe", cursor: "base" });
    socket.message({ type: "ping" });
    expect(JSON.parse(socket.sent[1])).toEqual({ type: "pong" });
    socket.message({
      type: "delta",
      from: "base",
      delta: { cursor: "next", upserts: [], deletions: [], accounts: [] },
    });
    await Promise.resolve();
    expect(options.changed).toHaveBeenCalledWith({
      from: "base",
      delta: { cursor: "next", upserts: [], deletions: [], accounts: [] },
    });
  });
  it("falls back immediately and reconnects with bounded jittered backoff", async () => {
    const { client } = setup();
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].onerror?.();
    expect(liveInterval(client)).toBe(4000);
    await vi.advanceTimersByTimeAsync(499);
    expect(Socket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].end();
    await vi.advanceTimersByTimeAsync(999);
    expect(Socket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    Socket.instances[2].message({ type: "ready" });
    expect(liveHealthy(client)).toBe(true);
  });
  it("invalidates the network-only path and catches up on reconnect and visibility", async () => {
    const { options } = setup();
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].message({ type: "ready" });
    await Promise.resolve();
    expect(options.changed).toHaveBeenCalledWith(undefined);
    options.changed.mockClear();
    Socket.instances[0].message({ type: "changed", cursor: "next" });
    await Promise.resolve();
    expect(options.changed).toHaveBeenCalledOnce();
    await Promise.resolve();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(options.changed).toHaveBeenCalledTimes(2);
  });
  it("suspends offline, resumes online and detects a silent connection", async () => {
    const { client } = setup("base");
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].message({ type: "ready" });
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(liveInterval(client)).toBe(4000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    online = true;
    window.dispatchEvent(new Event("online"));
    Socket.instances[1].message({ type: "ready" });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(liveHealthy(client)).toBe(false);
  });
  it("closes on logout/reset or server expiry without reconnecting", async () => {
    const { client } = setup("base");
    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].message({ type: "ready" });
    Socket.instances[0].end(4401);
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(liveHealthy(client)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    setup("other");
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event(REPLICA_RESET_EVENT));
    expect(Socket.instances[1].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(2);
  });
  it("keeps polling if WebSocket construction is blocked", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("Upgrade blocked");
        }
      },
    );
    const { client } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveInterval(client)).toBe(4000);
    expect(() => window.dispatchEvent(new Event("online"))).not.toThrow();
  });
  it("supports browsers without a WebSocket implementation", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const { live, client } = setup("base");
    await vi.advanceTimersByTimeAsync(0);
    expect(() => live.subscribe()).not.toThrow();
    expect(liveInterval(client)).toBe(4000);
  });
  it("coalesces updates while optimistic writes are pending, including the network fallback", async () => {
    const client = new QueryClient();
    let allowed = false;
    const changed = vi.fn();
    const live = new LiveUpdates(client, {
      verified: () => true,
      cursor: () => undefined,
      changed,
      wake: vi.fn(),
      canApply: () => allowed,
    });
    active.push(live);
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0];
    socket.message({ type: "ready" });
    socket.message({ type: "changed", cursor: "one" });
    socket.message({ type: "changed", cursor: "two" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).not.toHaveBeenCalled();
    allowed = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(changed).toHaveBeenCalledOnce();
  });
});
