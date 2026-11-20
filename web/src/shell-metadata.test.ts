import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import {
  forgetShellMetadata,
  readShellMetadata,
  rememberAccounts,
  rememberSession,
  SHELL_METADATA_KEY,
  UNAUTHORIZED_EVENT,
} from "./shell-metadata";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("shell metadata", () => {
  it("handles empty storage and persists only a verified-session marker and account metadata", () => {
    expect(readShellMetadata()).toBeUndefined();
    rememberSession();
    rememberAccounts([
      {
        id: "a",
        email: "owner@example.test",
        displayName: "Owner",
        provider: "gmail",
        status: "active",
        lastSyncedAt: null,
      },
    ]);
    expect(readShellMetadata()?.accounts[0].email).toBe("owner@example.test");
    forgetShellMetadata();
    rememberAccounts([]);
    expect(readShellMetadata()).toBeUndefined();
  });
  it.each(["not json", '{"version":2,"accounts":[]}', '{"version":1,"accounts":[{}]}'])(
    "ignores invalid persisted metadata %s",
    (value) => {
      localStorage.setItem(SHELL_METADATA_KEY, value);
      expect(readShellMetadata()).toBeUndefined();
    },
  );
  it("tolerates disabled storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Disabled");
    });
    expect(() => {
      rememberSession();
      rememberAccounts([]);
      forgetShellMetadata();
    }).not.toThrow();
    expect(readShellMetadata()).toBeUndefined();
  });
  it("evicts shell metadata and notifies the login boundary for an API 401", async () => {
    rememberSession();
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response('{"error":"Authentication required"}', { status: 401 })),
    );
    await expect(api("/api/accounts")).rejects.toBeInstanceOf(ApiError);
    expect(readShellMetadata()).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });
  it("does not treat an incorrect login password or a server failure as session revocation", async () => {
    rememberSession();
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"Wrong password"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api("/api/auth/login", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    await expect(api("/api/accounts")).rejects.toBeInstanceOf(ApiError);
    expect(readShellMetadata()).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });
});
