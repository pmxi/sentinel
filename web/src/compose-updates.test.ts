import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { sentApi } from "./api";
import { ComposeProvider, useCompose } from "./compose";
import { registerShellWorker } from "./service-worker";
import type { Account, Draft } from "./shared";
import { TriageProvider } from "./triage";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["normal", "failure", "empty"])(
  "defers updates until close, preserving attachments and flushing text (%s)",
  async (mode) => {
    const events = new EventTarget();
    const worker = {
      controller: {} as object,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      register: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.stubGlobal("navigator", { serviceWorker: worker });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const registration = await registerShellWorker();
    if (typeof registration === "function") cleanups.push(registration);
    let finish!: (value: Draft) => void;
    let fail!: (cause: Error) => void;
    const saved = new Promise<Draft>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    cleanups.push(() => finish({ id: "draft-1" } as Draft));
    vi.spyOn(sentApi, "saveDraft")
      .mockReturnValueOnce(saved)
      .mockImplementation(async (value) => ({ ...value, id: "draft-1" }) as Draft);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const account = {
      id: "account",
      provider: "gmail",
      email: "owner@example.test",
      displayName: "Owner",
      status: "active",
      lastSyncedAt: null,
    } as Account;
    const Open = () => {
      useCompose().openCompose(
        mode === "empty"
          ? {}
          : { subject: "Unsaved subject", files: [new File(["attachment"], "important.txt")] },
      );
      return null;
    };
    const dispose = render(
      () =>
        createComponent(QueryClientProvider, {
          client,
          get children() {
            return createComponent(TriageProvider, {
              get children() {
                return createComponent(ComposeProvider, {
                  accounts: [account],
                  get children() {
                    return createComponent(Open, {});
                  },
                });
              },
            });
          },
        }),
      container,
    );
    cleanups.push(() => {
      dispose();
      client.clear();
      container.remove();
    });
    const body = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!body) throw new Error("Missing composer");
    if (mode === "empty") {
      worker.controller = {};
      events.dispatchEvent(new Event("controllerchange"));
      expect(reload).not.toHaveBeenCalled();
      expect(sentApi.saveDraft).not.toHaveBeenCalled();
      container.querySelector<HTMLButtonElement>('[aria-label="Close composer"]')?.click();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      expect(sentApi.saveDraft).not.toHaveBeenCalled();
      return;
    }
    body.value = "Text typed less than 750ms before the update";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    worker.controller = {};
    events.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sentApi.saveDraft).toHaveBeenCalledOnce());
    expect(container.textContent).toContain("important.txt");
    body.value = "Newest text during the pending save";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>('[aria-label="Close composer"]')?.click();
    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector(".composer")).not.toBeNull();
    if (mode === "failure") {
      fail(new Error("Draft save unavailable"));
      await vi.waitFor(() => expect(container.textContent).toContain("Draft save unavailable"));
      expect(reload).not.toHaveBeenCalled();
      expect(container.textContent).toContain("important.txt");
      container.querySelector<HTMLButtonElement>('[aria-label="Close composer"]')?.click();
    } else finish({ id: "draft-1" } as Draft);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(vi.mocked(sentApi.saveDraft).mock.calls.at(-1)?.[0]).toMatchObject({
      ...(mode === "failure" ? {} : { id: "draft-1" }),
      body: "Newest text during the pending save",
    });
    expect(container.querySelector(".composer")).toBeNull();
  },
);
