import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endReplicaSession,
  prepareReplicaStorage,
  REPLICA_REVOKED_KEY,
  waitForReplicaWipe,
} from "./replica-session";
import { REPLICA_SESSION_KEY } from "./replica-types";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("private replica cleanup", () => {
  it("retains the session identifier until physical deletion completes", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    localStorage.setItem(REPLICA_SESSION_KEY, id);
    let finish!: () => void;
    const removeEntry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ removeEntry }) } });
    const wiping = endReplicaSession();
    const retained = localStorage.getItem(REPLICA_SESSION_KEY);
    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalled());
    finish();
    await wiping;
    expect(retained).toBe(id);
    expect(localStorage.getItem(REPLICA_SESSION_KEY)).toBeNull();
  });
  it("recovers orphaned databases at startup without deleting a live database or unrelated files", async () => {
    const live = "00000000-0000-4000-8000-000000000001",
      stale = "00000000-0000-4000-8000-000000000002";
    localStorage.setItem(REPLICA_SESSION_KEY, live);
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({
          removeEntry,
          async *keys() {
            yield `.sent-mailbox-${live}`;
            yield `.sent-mailbox-${stale}`;
            yield "unrelated";
          },
        }),
      },
    });
    await prepareReplicaStorage(true);
    expect(removeEntry.mock.calls.map(([name]) => name)).toEqual([`.sent-mailbox-${stale}`]);
    removeEntry.mockClear();
    await prepareReplicaStorage(false);
    expect(removeEntry).toHaveBeenCalledWith(`.sent-mailbox-${live}`, { recursive: true });
    expect(localStorage.getItem(REPLICA_SESSION_KEY)).toBeNull();
  });
  it("keeps a durable revoked identifier when deletion fails and bounds navigation waits", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    localStorage.setItem(REPLICA_SESSION_KEY, id);
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => ({
          removeEntry: async () => {
            throw new Error("Denied");
          },
        }),
      },
    });
    await endReplicaSession();
    expect(localStorage.getItem(REPLICA_SESSION_KEY)).toBe(id);
    expect(localStorage.getItem(REPLICA_REVOKED_KEY)).toBe(id);
    vi.useFakeTimers();
    const waiting = waitForReplicaWipe(new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    vi.useRealTimers();
  });
  it("handles an empty or unavailable storage root", async () => {
    vi.stubGlobal("navigator", {});
    await prepareReplicaStorage(false);
    await endReplicaSession();
    expect(localStorage.getItem(REPLICA_SESSION_KEY)).toBeNull();
  });
});
