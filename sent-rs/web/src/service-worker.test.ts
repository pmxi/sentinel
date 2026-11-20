import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShellWorker } from "./service-worker";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("shell registration", () => {
  it("claims without reloading on first install, reloads once for an update and checks for updates when visible", async () => {
    const events = new EventTarget();
    const update = vi.fn().mockResolvedValue(undefined);
    const registration = { update };
    const worker = {
      controller: null as object | null,
      register: vi.fn().mockResolvedValue(registration),
      addEventListener: events.addEventListener.bind(events),
    };
    vi.stubGlobal("navigator", { serviceWorker: worker });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const listeners = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    await registerShellWorker();
    expect(worker.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(update).toHaveBeenCalledOnce();
    worker.controller = {};
    events.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    worker.controller = {};
    events.dispatchEvent(new Event("controllerchange"));
    events.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const listener = listeners.mock.calls.find(([name]) => name === "visibilitychange")?.[1];
    if (typeof listener !== "function") throw new Error("Missing update listener");
    listener.call(document, new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(2);
  });
  it("does not block startup when registration is unsupported or denied", async () => {
    vi.stubGlobal("navigator", {});
    await expect(registerShellWorker()).resolves.toBeUndefined();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: null,
        addEventListener: vi.fn(),
        register: vi.fn().mockRejectedValue(new Error("Disabled")),
      },
    });
    await expect(registerShellWorker()).resolves.toBeUndefined();
  });
});
