import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  server: { proxy: { "/api": "http://localhost:3000" } },
  test: { environment: "happy-dom", include: ["src/*.test.ts"] },
});
