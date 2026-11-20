import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { prepareWarmMailbox, prepareWarmReload } from "../src/warm.ts";

describe("warm mailbox preparation", () => {
  it("allows a large throttled replica to initialize beyond the shell-only setup budget", async () => {
    vi.useFakeTimers();
    try {
      const page = {
        waitForLoadState: vi
          .fn()
          .mockResolvedValue(undefined)
          .mockImplementationOnce(
            () => new Promise<void>((resolve) => setTimeout(resolve, 45_000)),
          ),
        evaluate: vi.fn().mockResolvedValue({ registered: false, controlled: false }),
        locator: vi.fn().mockReturnValue({ getAttribute: vi.fn().mockResolvedValue("loading") }),
        waitForFunction: vi.fn().mockResolvedValue(undefined),
      };
      const pending = prepareWarmMailbox(page as unknown as Page);
      await vi.advanceTimersByTimeAsync(45_001);
      await pending;
      expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 300_000 });
      expect(page.waitForFunction.mock.calls[0]?.[2]).toEqual({ timeout: 300_000 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not time navigation while recent-body background sync is still running", async () => {
    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ registered: false, controlled: false }),
      locator: vi.fn().mockReturnValue({ getAttribute: vi.fn().mockResolvedValue("ready") }),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    };
    await prepareWarmMailbox(page as unknown as Page);
    const ready = page.waitForFunction.mock.calls[0]?.[0] as () => boolean;
    const dataset = { sentReplica: "ready", sentReplicaBodies: "syncing" };
    vi.stubGlobal("document", { documentElement: { dataset } });
    try {
      expect(ready()).toBe(false);
      dataset.sentReplicaBodies = "ready";
      expect(ready()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([null, "loading", "ready"])(
    "waits for a replica only when advertised: %s",
    async (marker) => {
      const page = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({ registered: false, controlled: false }),
        locator: vi.fn().mockReturnValue({ getAttribute: vi.fn().mockResolvedValue(marker) }),
        waitForFunction: vi.fn().mockResolvedValue(undefined),
      };
      await prepareWarmMailbox(page as unknown as Page);
      expect(page.waitForFunction).toHaveBeenCalledTimes(marker ? 1 : 0);
      expect(page.waitForLoadState).toHaveBeenCalledTimes(marker ? 2 : 1);
    },
  );
  it("records failed replica preparation as a sample failure", async () => {
    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ registered: false, controlled: false }),
      locator: vi.fn().mockReturnValue({ getAttribute: vi.fn().mockResolvedValue("loading") }),
      waitForFunction: vi.fn().mockRejectedValue(new Error("Replica readiness timed out")),
    };
    await expect(prepareWarmMailbox(page as unknown as Page)).rejects.toThrow(
      "Replica readiness timed out",
    );
  });
});

describe("warm reload preparation", () => {
  it("bounds a failed install's never-settling readiness and can prepare the next sample", async () => {
    vi.useFakeTimers();
    try {
      const page = {
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        evaluate: vi
          .fn()
          .mockReturnValueOnce(new Promise(() => {}))
          .mockResolvedValue({ registered: false, controlled: false }),
        reload: vi.fn(),
      };
      const failures: string[] = [];
      const pending = prepareWarmReload(page as unknown as Page).catch((cause: Error) => {
        failures.push(cause.message);
      });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(failures).toEqual(["Warm reload setup timed out after 30000ms"]);
      await pending;
      await prepareWarmReload(page as unknown as Page);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      expect(page.reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { registered: false, controlled: false },
    { registered: true, controlled: true },
  ])("does not add an untimed navigation when %j", async (state) => {
    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(state),
      reload: vi.fn().mockResolvedValue(null),
    };
    await prepareWarmReload(page as unknown as Page);
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 30_000 });
    expect(page.reload).not.toHaveBeenCalled();
  });
  it("navigates outside measurement if an installed worker has not claimed its first page", async () => {
    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ registered: true, controlled: false }),
      reload: vi.fn().mockResolvedValue(null),
    };
    await prepareWarmReload(page as unknown as Page);
    expect(page.reload).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
    expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
  });
  it("surfaces worker setup failures instead of reporting a successful warm measurement", async () => {
    const page = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockRejectedValue(new Error("Worker install failed")),
      reload: vi.fn(),
    };
    await expect(prepareWarmReload(page as unknown as Page)).rejects.toThrow(
      "Worker install failed",
    );
    expect(page.reload).not.toHaveBeenCalled();
  });
});
