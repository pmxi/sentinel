import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationDirectory } from "../src/db/migration-path.ts";

describe("migration discovery", () => {
  let root: string;
  let sourceUrl: string;
  let bundledUrl: string;
  let localPath: string;
  let legacyPath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sent-migrations-"));
    localPath = join(root, "release", "migrations");
    legacyPath = join(root, "legacy", "migrations");
    await mkdir(localPath, { recursive: true });
    await mkdir(legacyPath, { recursive: true });
    sourceUrl = pathToFileURL(join(root, "release", "migrate.ts")).href;
    bundledUrl = pathToFileURL(join(root, "dist", "migrate.js")).href;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the current release's source migrations even with a stale external path", () => {
    expect(resolveMigrationDirectory(sourceUrl, legacyPath)).toBe(localPath);
    expect(resolveMigrationDirectory(sourceUrl)).toBe(localPath);
  });

  it("uses the external path for bundles without adjacent migrations, including Docker", () => {
    expect(resolveMigrationDirectory(bundledUrl, legacyPath)).toBe(legacyPath);
  });

  it("fails rather than silently skipping migrations when neither directory exists", () => {
    expect(() => resolveMigrationDirectory(bundledUrl)).toThrow("Migration directory");
    expect(() => resolveMigrationDirectory(bundledUrl, join(root, "missing"))).toThrow(
      "Migration directory",
    );
  });
});
