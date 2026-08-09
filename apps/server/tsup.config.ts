import { defineConfig } from "tsup";

export default defineConfig({
  noExternal: ["@sent/core", "@sent/shared"],
  external: [
    "@azure/msal-node",
    "drizzle-orm",
    "googleapis",
    "html-to-text",
    "jose",
    "mailparser",
    "nodemailer",
    "openai",
    "pg",
    "sanitize-html",
    "zod",
  ],
});
