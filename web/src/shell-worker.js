const CACHE_NAME = __SHELL_CACHE__;
const PRECACHE = __PRECACHE__;
const PREFIX = "sent-shell-";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await Promise.all(
          PRECACHE.map(async ({ url, digest }) => {
            const response = await fetch(
              new Request(new URL(url, self.location.origin), {
                cache: url === "/index.html" ? "reload" : "default",
                credentials: "same-origin",
              }),
            );
            if (!response.ok || response.redirected) throw new Error(`Cannot precache ${url}`);
            const hash = await crypto.subtle.digest(
              "SHA-256",
              await response.clone().arrayBuffer(),
            );
            const actual = Array.from(new Uint8Array(hash), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            if (actual !== digest) throw new Error(`Build changed while precaching ${url}`);
            await cache.put(url, response);
          }),
        );
        await self.skipWaiting();
      } catch (error) {
        await caches.delete(CACHE_NAME);
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        (await caches.keys())
          .filter((name) => name.startsWith(PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  )
    return;
  const path = request.mode === "navigate" ? "/index.html" : url.pathname;
  if (!PRECACHE.some((entry) => entry.url === path)) return;
  event.respondWith(
    (async () => (await (await caches.open(CACHE_NAME)).match(path)) ?? fetch(request))(),
  );
});
