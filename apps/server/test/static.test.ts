import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { env, type SentServices } from "@sent/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.ts";

vi.mock("@sent/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sent/core")>()),
  env: vi.fn(),
}));

const asset = "console.log('compressed asset');".repeat(100);
const index = "<!doctype html><title>Sent</title>";
let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sent-static-"));
  await mkdir(join(root, "assets"));
  for (const [name, content] of [
    ["assets/index-abcdefgh.js", asset],
    ["index.html", index],
  ]) {
    await writeFile(join(root, name), content);
    await writeFile(join(root, `${name}.br`), brotliCompressSync(content));
    await writeFile(join(root, `${name}.gz`), gzipSync(content));
  }
  await writeFile(join(root, "assets/raw-abcdefgh.js"), asset);
  vi.mocked(env).mockReturnValue({
    WEB_DIST_PATH: root,
    LOG_LEVEL: "silent",
    SENT_PUBLIC_URL: "http://localhost:3000",
  } as ReturnType<typeof env>);
  app = await buildServer({
    services: { repository: {} } as SentServices,
    passwordHash: "not-used",
    sessionSecret: "static-test-session-secret-long-enough",
  });
});

afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

it.each([
  ["br, gzip", "br", brotliDecompressSync],
  ["gzip", "gzip", gunzipSync],
] as const)("serves compressed assets for %s", async (acceptEncoding, encoding, decompress) => {
  const response = await app.inject({
    url: "/assets/index-abcdefgh.js",
    headers: { "accept-encoding": acceptEncoding },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe(encoding);
  expect(response.headers.vary).toMatch(/accept-encoding/i);
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(response.headers["content-type"]).toContain("javascript");
  expect(decompress(response.rawPayload).toString()).toBe(asset);
});

it.each([undefined, "identity", "br;q=0, gzip;q=0"])(
  "serves unencoded assets for %s",
  async (acceptEncoding) => {
    const response = await app.inject({
      url: "/assets/index-abcdefgh.js",
      headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers.vary).toMatch(/accept-encoding/i);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.body).toBe(asset);
  },
);

it("falls back to the raw asset when compressed files are absent", async () => {
  const response = await app.inject({
    url: "/assets/raw-abcdefgh.js",
    headers: { "accept-encoding": "br, gzip" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers.vary).toMatch(/accept-encoding/i);
  expect(response.body).toBe(asset);
});

it.each(["/", "/index.html", "/inbox/thread", "/assets/missing.js"])(
  "serves revalidated HTML at %s",
  async (url) => {
    const response = await app.inject({ url, headers: { "accept-encoding": "br, gzip" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(response.rawPayload).toString()).toBe(index);
  },
);

it("does not encode API JSON errors or serve the SPA for API requests", async () => {
  const response = await app.inject({
    url: "/api/private",
    headers: { "accept-encoding": "br, gzip" },
  });
  expect(response.statusCode).toBe(401);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBeUndefined();
  expect(response.json()).toEqual({ error: "Authentication required" });
});
