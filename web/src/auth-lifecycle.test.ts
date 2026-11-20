import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthenticatedSession } from "./App";
import { forgetShellMetadata } from "./shell-metadata";

vi.mock("./shell-metadata", async (original) => ({
  ...(await original<typeof import("./shell-metadata")>()),
  forgetShellMetadata: vi.fn(() => Promise.resolve()),
}));
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["session"], { authenticated: true });
  client.setQueryData(["messages", "l1"], { messages: ["private"] });
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});
describe("authentication lifecycle", () => {
  it("clears private queries on remote logout or expiry", () => {
    const client = setup();
    clearAuthenticatedSession(client);
    expect(client.getQueryData(["session"])).toEqual({ authenticated: false });
    expect(client.getQueryData(["messages", "l1"])).toBeUndefined();
    expect(forgetShellMetadata).toHaveBeenCalledOnce();
  });
  it("does not offer login before the local logout response and navigation complete", async () => {
    const client = setup();
    let complete!: () => void;
    const mutation = client.getMutationCache().build(client, {
      mutationKey: ["logout"],
      mutationFn: () =>
        new Promise<void>((done) => {
          complete = done;
        }),
    });
    const pending = mutation.execute(undefined);
    await Promise.resolve();
    clearAuthenticatedSession(client);
    expect(client.getQueryData(["session"])).toEqual({ authenticated: true });
    expect(client.getQueryData(["messages", "l1"])).toBeDefined();
    expect(forgetShellMetadata).not.toHaveBeenCalled();
    complete();
    await pending;
  });
  it("does not suppress expiry after a failed logout", async () => {
    const client = setup();
    let fail!: (error: Error) => void;
    const mutation = client.getMutationCache().build(client, {
      mutationKey: ["logout"],
      mutationFn: () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    });
    const pending = mutation.execute(undefined).catch(() => {});
    await Promise.resolve();
    fail(new Error("network unavailable"));
    await pending;
    clearAuthenticatedSession(client);
    expect(client.getQueryData(["session"])).toEqual({ authenticated: false });
  });
  it("is idempotent with an empty query cache", () => {
    const client = new QueryClient();
    clients.push(client);
    clearAuthenticatedSession(client);
    clearAuthenticatedSession(client);
    expect(client.getQueryData(["session"])).toEqual({ authenticated: false });
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });
});
