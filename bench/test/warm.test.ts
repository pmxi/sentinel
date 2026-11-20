import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { prepareWarmReload } from "../src/warm.ts";

describe("warm reload preparation", () => {
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
