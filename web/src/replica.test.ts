import { QueryClient } from "@tanstack/solid-query";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMailboxReplica, MailboxReplica, replicaFor, replicaId } from "./replica";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("replica initialization", () => {
  it("does not abort on HTTP origins without randomUUID", () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(undefined as never);
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    createRoot((dispose) => {
      const client = new QueryClient();
      expect(() => {
        const replica = new MailboxReplica(
          client,
          () => true,
          () => true,
        );
        expect(replica.id).toMatch(/^[a-f0-9-]{36}$/);
        expect(() => replica.begin({ id: "message", action: "archive" })).not.toThrow();
        void replica.close();
      }).not.toThrow();
      dispose();
      client.clear();
    });
  });
  it("generates distinct version-four identities even without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    const first = replicaId();
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(replicaId()).not.toBe(first);
  });
  it("keeps the network path when construction fails", () => {
    createRoot((dispose) => {
      const client = new QueryClient();
      vi.spyOn(window, "addEventListener").mockImplementation(() => {
        throw new Error("Unavailable");
      });
      expect(
        createMailboxReplica(
          client,
          () => true,
          () => true,
        ),
      ).toBeUndefined();
      expect(replicaFor(client)).toBeUndefined();
      dispose();
      client.clear();
    });
  });
});
