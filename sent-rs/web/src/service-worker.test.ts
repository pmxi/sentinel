import { afterEach, describe, expect, it, vi } from "vitest";
import { holdShellReload, registerShellWorker } from "./service-worker";
import { forgetShellMetadata } from "./shell-metadata";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("shell registration", () => {
  it.each([1, 2])(
    "does not reload a revoked session until its private replica is wiped (%s revocations)",
    async (revocations) => {
      const events = new EventTarget();
      let finish!: () => void;
      const deleting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const worker = {
        controller: {} as object,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        register: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
      };
      const removeEntry = vi.fn().mockReturnValue(deleting);
      vi.stubGlobal("navigator", {
        serviceWorker: worker,
        storage: { getDirectory: vi.fn().mockResolvedValue({ removeEntry }) },
      });
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {}),
        dispose = await registerShellWorker(),
        release = holdShellReload(async () => {});
      localStorage.setItem("sent:replica:session:v1", crypto.randomUUID());
      try {
        worker.controller = {};
        events.dispatchEvent(new Event("controllerchange"));
        for (let index = 0; index < revocations; index++) forgetShellMetadata();
        expect(reload).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(removeEntry).toHaveBeenCalled());
        expect(reload).not.toHaveBeenCalled();
        finish();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      } finally {
        finish();
        release();
        if (typeof dispose === "function") dispose();
      }
    },
  );
  it("clears revoked-session guards without letting their late failures release a new composer's guard", async () => {
    const events = new EventTarget();
    const worker = {
      controller: {} as object,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      register: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.stubGlobal("navigator", { serviceWorker: worker });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const dispose = await registerShellWorker();
    let reject!: (cause: Error) => void;
    const oldSave = new Promise<void>((_, no) => {
      reject = no;
    });
    const oldRelease = holdShellReload(() => oldSave);
    oldRelease();
    await Promise.resolve();
    forgetShellMetadata();
    const release = holdShellReload(async () => {});
    try {
      worker.controller = {};
      events.dispatchEvent(new Event("controllerchange"));
      reject(new Error("Old session's save returned 401"));
      await new Promise((done) => setTimeout(done, 0));
      expect(reload).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    } finally {
      release();
      if (typeof dispose === "function") dispose();
    }
  });
  it.each([false, true])(
    "releases an unmounted composer's guard after its flush settles (401=%s)",
    async (unauthorized) => {
      const events = new EventTarget();
      const worker = {
        controller: {} as object,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        register: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
      };
      vi.stubGlobal("navigator", { serviceWorker: worker });
      const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
      const dispose = await registerShellWorker();
      let resolve!: () => void;
      let reject!: (cause: Error) => void;
      let pending = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const release = holdShellReload(() => pending);
      try {
        worker.controller = {};
        events.dispatchEvent(new Event("controllerchange"));
        expect(reload).not.toHaveBeenCalled();
        release();
        expect(reload).not.toHaveBeenCalled();
        if (unauthorized) reject(new Error("401 Unauthorized"));
        else resolve();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      } finally {
        pending = Promise.resolve();
        release();
        if (typeof dispose === "function") dispose();
        await Promise.resolve();
      }
    },
  );
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
