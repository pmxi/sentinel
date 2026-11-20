import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { prepareWarmReload } from "../src/warm.ts";

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
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle");
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
