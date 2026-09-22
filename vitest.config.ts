import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    coverage: { reporter: ["text", "json-summary"] },
    include: ["**/*.test.ts"],
    passWithNoTests: false,
  },
});
