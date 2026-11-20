import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "precompress-web-assets",
      apply: "build",
      async writeBundle(options, bundle) {
        for (const fileName of Object.keys(bundle)) {
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
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
