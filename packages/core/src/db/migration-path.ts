import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveMigrationDirectory(moduleUrl: string, externalPath?: string): string {
  const localPath = join(dirname(fileURLToPath(moduleUrl)), "migrations");
  if (existsSync(localPath)) return localPath;
  if (externalPath && existsSync(externalPath)) return externalPath;
  throw new Error("Migration directory could not be resolved");
}
