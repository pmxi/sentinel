import "dotenv/config";
import { env } from "@sent/core";
import { buildServer } from "./app.ts";

const app = await buildServer();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env().HOST, port: env().PORT });
