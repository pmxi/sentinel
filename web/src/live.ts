import type { QueryClient } from "@tanstack/solid-query";
import { type Accessor, createSignal } from "solid-js";
import { REPLICA_RESET_EVENT } from "./replica-session";
import type { ReplicaDelta } from "./replica-types";
import { UNAUTHORIZED_EVENT } from "./shell-metadata";

export type LiveDelta = { from: string; delta: ReplicaDelta };
type Options = {
  verified: () => boolean;
  cursor: () => string | undefined;
  changed: (frame?: LiveDelta) => Promise<void> | void;
  wake: () => void;
  canApply?: () => boolean;
};
const connections = new WeakMap<QueryClient, LiveUpdates>();
export const liveHealthy = (client: QueryClient) => connections.get(client)?.healthy() ?? false;
export const liveInterval = (client: QueryClient) => (liveHealthy(client) ? 60_000 : 4000);

export class LiveUpdates {
  readonly healthy: Accessor<boolean>;
  private setHealthy: (value: boolean) => void;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private closed = false;
  private running = false;
  private queued = false;
  private pending?: LiveDelta;
  private remoteCursor?: string;
  private subscribed = false;
  private subscribedCursor?: string;
  private quiet?: ReturnType<typeof setTimeout>;
  private releaseQuiet?: () => void;
  constructor(
    private client: QueryClient,
    private options: Options,
  ) {
    [this.healthy, this.setHealthy] = createSignal(false);
    connections.set(client, this);
    window.addEventListener("online", this.resume);
    window.addEventListener("offline", this.offline);
    document.addEventListener("visibilitychange", this.visible);
    window.addEventListener(REPLICA_RESET_EVENT, this.close);
    window.addEventListener(UNAUTHORIZED_EVENT, this.close);
    this.timer = setTimeout(this.connect, 0);
  }
  private health(value: boolean) {
    if (this.healthy() === value) return;
    this.setHealthy(value);
    this.options.wake();
  }
  private connect = () => {
    clearTimeout(this.timer);
    if (
      this.closed ||
      this.socket ||
      navigator.onLine === false ||
      typeof WebSocket === "undefined"
    )
      return;
    if (!this.options.verified()) {
      this.timer = setTimeout(this.connect, 1000);
      return;
    }
    try {
      const url = new URL("/api/live", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      this.remoteCursor = undefined;
      this.subscribed = false;
      this.subscribedCursor = undefined;
      socket.onmessage = (event) => this.receive(socket, event.data);
      socket.onerror = () => this.disconnected(socket);
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        if (event.code === 4401) {
          this.close();
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        } else this.disconnected(socket);
      };
      this.heartbeat = setTimeout(() => this.disconnected(socket), 45_000);
    } catch {
      this.retry();
    }
  };
  private retry() {
    if (this.closed || navigator.onLine === false) return;
    const base = Math.min(30_000, 500 * 2 ** Math.min(10, this.attempts++));
    this.timer = setTimeout(
      this.connect,
      Math.min(30_000, Math.round(base * (0.5 + Math.random()))),
    );
  }
  private disconnected(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    clearTimeout(this.heartbeat);
    this.health(false);
    try {
      socket.close();
    } catch {}
    this.retry();
  }
  private receive(socket: WebSocket, data: unknown) {
    if (this.socket !== socket || typeof data !== "string" || data.length > 65_536) return;
    try {
      const frame = JSON.parse(data);
      clearTimeout(this.heartbeat);
      this.heartbeat = setTimeout(() => this.disconnected(socket), 45_000);
      if (frame.type === "ready") {
        this.attempts = 0;
        this.health(true);
        this.subscribe();
        this.queue();
      } else if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      } else if (frame.type === "changed" && typeof frame.cursor === "string") {
        if (frame.cursor === this.remoteCursor) return;
        this.remoteCursor = frame.cursor;
        this.queue();
      } else if (
        frame.type === "delta" &&
        typeof frame.from === "string" &&
        typeof frame.delta?.cursor === "string" &&
        Array.isArray(frame.delta.upserts) &&
        Array.isArray(frame.delta.deletions) &&
        Array.isArray(frame.delta.accounts)
      ) {
        this.remoteCursor = frame.delta.cursor;
        this.queue({ from: frame.from, delta: frame.delta });
      }
    } catch {
      this.disconnected(socket);
    }
  }
  subscribe() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.healthy()) return;
    const cursor = this.options.cursor();
    if (this.subscribed && cursor === this.subscribedCursor) return;
    try {
      this.subscribed = true;
      this.subscribedCursor = cursor;
      this.socket.send(JSON.stringify({ type: "subscribe", cursor }));
    } catch {
      this.disconnected(this.socket);
    }
  }
  private queue(frame?: LiveDelta) {
    this.queued = true;
    this.pending = frame;
    if (!this.running) void this.drain();
  }
  private async drain() {
    this.running = true;
    try {
      while (this.queued && !this.closed && navigator.onLine !== false) {
        if (this.options.canApply?.() === false) {
          await new Promise<void>((done) => {
            this.releaseQuiet = done;
            this.quiet = setTimeout(() => {
              this.releaseQuiet = undefined;
              done();
            }, 250);
          });
          continue;
        }
        this.queued = false;
        const frame = this.pending;
        this.pending = undefined;
        await this.options.changed(frame);
      }
      const cursor = this.options.cursor();
      if (!this.closed && cursor && cursor !== this.remoteCursor) this.subscribe();
    } catch {
      if (this.socket) this.disconnected(this.socket);
    } finally {
      this.running = false;
    }
  }
  private resume = () => {
    if (this.closed) return;
    this.connect();
    this.queue();
  };
  private visible = () => {
    if (document.visibilityState === "visible") this.resume();
  };
  private offline = () => {
    const socket = this.socket;
    this.socket = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeat);
    this.health(false);
    try {
      socket?.close();
    } catch {}
  };
  close = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.quiet);
    this.releaseQuiet?.();
    this.releaseQuiet = undefined;
    this.offline();
    window.removeEventListener("online", this.resume);
    window.removeEventListener("offline", this.offline);
    document.removeEventListener("visibilitychange", this.visible);
    window.removeEventListener(REPLICA_RESET_EVENT, this.close);
    window.removeEventListener(UNAUTHORIZED_EVENT, this.close);
    if (connections.get(this.client) === this) connections.delete(this.client);
  };
}
