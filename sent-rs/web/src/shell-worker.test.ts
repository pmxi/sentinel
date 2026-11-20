// @vitest-environment node
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const files = new Map([
  ["/index.html", "<html>Sent</html>"],
  ["/assets/app-hash.js", "app()"],
  ["/assets/app-hash.css", "body{}"],
]);
function worker() {
  const records = new Map<string, Map<string, Response>>();
  const caches = {
    keys: async () => [...records.keys()],
    delete: async (name: string) => records.delete(name),
    open: async (name: string) => {
      const data = records.get(name) ?? new Map<string, Response>();
      records.set(name, data);
      return {
        put: async (path: string, response: Response) => {
          data.set(path, response.clone());
        },
        match: async (path: string) => data.get(path)?.clone(),
      };
    },
  };
  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    location: { origin: "https://sent.test" },
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      handlers.set(name, callback),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const fetch = vi.fn(
    async (request: Request) =>
      new Response(files.get(new URL(request.url).pathname) ?? "network", { status: 200 }),
  );
  const manifest = Array.from(files, ([url, body]) => ({
    url,
    digest: createHash("sha256").update(body).digest("hex"),
  }));
  const source = readFileSync(new URL("./shell-worker.js", import.meta.url), "utf8")
    .replace("__SHELL_CACHE__", '"sent-shell-current"')
    .replace("__PRECACHE__", JSON.stringify(manifest));
  runInNewContext(source, { self, caches, fetch, Request, Response, URL, crypto: webcrypto });
  const lifecycle = async (name: string) => {
    let result: Promise<unknown> | undefined;
    handlers.get(name)?.({
      waitUntil: (promise: Promise<unknown>) => {
        result = promise;
      },
    });
    await result;
  };
  const request = (path: string, mode = "cors", method = "GET") => {
    const respondWith = vi.fn();
    handlers.get("fetch")?.({
      request: { url: new URL(path, self.location.origin).href, mode, method },
      respondWith,
    });
    return respondWith;
  };
  return { records, caches, self, fetch, lifecycle, request };
}

describe("shell worker", () => {
  it("precaches the complete build, keeps HTML revalidation, claims clients and removes only old shell caches", async () => {
    const sw = worker();
    await sw.caches.open("sent-shell-old");
    await sw.caches.open("another-app");
    await sw.lifecycle("install");
    expect([...(sw.records.get("sent-shell-current")?.keys() ?? [])].sort()).toEqual(
      [...files.keys()].sort(),
    );
    expect(
      sw.fetch.mock.calls.find(([request]) => new URL(request.url).pathname === "/index.html")?.[0]
        .cache,
    ).toBe("reload");
    expect(sw.self.skipWaiting).toHaveBeenCalledOnce();
    await sw.lifecycle("activate");
    expect(await sw.caches.keys()).toEqual(["another-app", "sent-shell-current"]);
    expect(sw.self.clients.claim).toHaveBeenCalledOnce();
    sw.fetch.mockClear();
    const navigation = sw.request("/inbox/l1?message=abc", "navigate");
    expect(await (await navigation.mock.calls[0][0]).text()).toBe(files.get("/index.html"));
    const asset = sw.request("/assets/app-hash.js");
    expect(await (await asset.mock.calls[0][0]).text()).toBe("app()");
    expect(sw.fetch).not.toHaveBeenCalled();
  });
  it("never intercepts APIs, writes, other origins, worker updates or unknown assets", async () => {
    const sw = worker();
    for (const [path, mode, method] of [
      ["/api/auth/session", "cors", "GET"],
      ["/api/messages?q=mail", "navigate", "GET"],
      ["/api", "navigate", "GET"],
      ["/index.html", "cors", "POST"],
      ["https://other.test/index.html", "navigate", "GET"],
      ["/sw.js", "cors", "GET"],
      ["/unknown.js", "cors", "GET"],
    ]) {
      expect(sw.request(path, mode, method)).not.toHaveBeenCalled();
    }
    expect(sw.records.size).toBe(0);
    expect(sw.fetch).not.toHaveBeenCalled();
  });
  it("falls through to the network on a cache miss without runtime caching", async () => {
    const sw = worker();
    const response = await sw.request("/assets/app-hash.js").mock.calls[0][0];
    expect(await response.text()).toBe("app()");
    expect(sw.fetch).toHaveBeenCalledOnce();
    expect(sw.records.get("sent-shell-current")?.size).toBe(0);
  });
  it.each(["network", "mismatched build", "HTTP error"])(
    "keeps the old shell active on %s during install",
    async (failure) => {
      const sw = worker();
      await sw.caches.open("sent-shell-old");
      if (failure === "network") sw.fetch.mockRejectedValue(new Error("Offline"));
      else
        sw.fetch.mockResolvedValue(
          new Response("wrong deployment", { status: failure === "HTTP error" ? 503 : 200 }),
        );
      await expect(sw.lifecycle("install")).rejects.toThrow();
      expect(await sw.caches.keys()).toEqual(["sent-shell-old"]);
      expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    },
  );
});
