import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SELECTORS } from "../src/metrics.ts";
import { installPaintObserver } from "../src/paint.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture(platform = "Linux") {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  const frames: (() => void)[] = [];
  let rowCount = 10;
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { platform });
  vi.stubGlobal("performance", { timeOrigin: 1000, now: () => 100 });
  vi.stubGlobal("document", {
    querySelectorAll: () => Array.from({ length: rowCount }, () => ({})),
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) =>
      listeners.set(type, listener),
  });
  vi.stubGlobal("requestAnimationFrame", (frame: () => void) => frames.push(frame));
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
    },
  );
  installPaintObserver(DEFAULT_SELECTORS);
  return {
    arm: (key?: string) => window.__sentBench.arm({ kind: "list" }, { type: "keydown", key }),
    press: (event: Partial<KeyboardEvent>) =>
      listeners.get("keydown")?.({
        type: "keydown",
        timeStamp: 50,
        key: "Enter",
        code: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...event,
      } as KeyboardEvent),
    paint: () => {
      while (frames.length) frames.shift()?.();
    },
    setRows: (count: number) => {
      rowCount = count;
    },
    load: () => listeners.get("load")?.({} as KeyboardEvent),
  };
}

describe("paint trigger keys", () => {
  it("starts Control+Enter at Enter, not modifier-down or an unmodified Enter", () => {
    const { arm, press, paint } = fixture();
    arm("Control+Enter");
    press({ key: "Control", code: "ControlLeft", ctrlKey: true });
    press({});
    expect(window.__sentBench.startEpoch).toBeNull();
    press({ ctrlKey: true });
    expect(window.__sentBench.startEpoch).toBe(1050);
    paint();
    expect(window.__sentBench.result).toBe(50);
    expect(window.__sentBench.endEpoch).toBe(1100);
  });

  it.each([
    ["j", { key: "j", code: "KeyJ" }],
    ["Alt+Shift+ArrowDown", { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true }],
    ["Meta+KeyK", { key: "k", code: "KeyK", metaKey: true }],
    ["Space", { key: " ", code: "Space" }],
    ["Control++", { key: "+", code: "Equal", ctrlKey: true }],
  ])("matches Playwright key %s", (key, event) => {
    const { arm, press, paint } = fixture();
    arm(key);
    press(event);
    paint();
    expect(window.__sentBench.result).toBe(50);
  });

  it.each(["Linux", "MacIntel"])("resolves ControlOrMeta on %s", (platform) => {
    const { arm, press, paint } = fixture(platform);
    arm("ControlOrMeta+Enter");
    press({ ctrlKey: platform === "Linux", metaKey: platform === "MacIntel" });
    paint();
    expect(window.__sentBench.result).toBe(50);
  });

  it("ignores extra, missing, or wrong modifiers and wrong keys", () => {
    const { arm, press, paint } = fixture();
    arm("Control+Enter");
    for (const event of [
      {},
      { metaKey: true },
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, key: "j", code: "KeyJ" },
    ])
      press(event);
    paint();
    expect(window.__sentBench.startEpoch).toBeNull();
    expect(window.__sentBench.result).toBeNull();
    arm("Enter");
    press({ ctrlKey: true });
    expect(window.__sentBench.startEpoch).toBeNull();
  });

  it("does not finish an empty result until rows render, and preserves unfiltered triggers", () => {
    const { arm, press, paint, setRows, load } = fixture();
    setRows(0);
    arm();
    press({});
    paint();
    expect(window.__sentBench.startEpoch).toBe(1050);
    expect(window.__sentBench.result).toBeNull();
    setRows(10);
    load();
    paint();
    expect(window.__sentBench.result).toBe(50);
  });
});
