import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { writeShellWorker } from "./shell-build.ts";

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "precompress-web-assets",
      apply: "build",
      async writeBundle(options, bundle) {
        const directory = options.dir ?? "dist";
        await writeShellWorker(directory, Object.keys(bundle));
        for (const fileName of [...Object.keys(bundle), "sw.js"]) {
          if (!/\.(?:js|css|html|svg|json)$/.test(fileName)) continue;
          const path = resolve(options.dir ?? "dist", fileName);
          const bytes = await readFile(path);
          for (const [extension, compress] of [
            ["br", brotliCompressSync],
            ["gz", gzipSync],
          ] as const) {
            await writeFile(`${path}.${extension}`, compress(bytes));
          }
        }
      },
    },
  ],
  server: { proxy: { "/api": "http://localhost:3000" } },
  test: { environment: "happy-dom", include: ["src/*.test.ts"] },
});
