// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeShellWorker } from "../shell-build";

describe("shell build manifest", () => {
  it("is deterministic, changes with build content and excludes non-shell paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sent-shell-"));
    try {
      await writeFile(join(directory, "index.html"), "<html>Build A</html>");
      const files = ["index.html", "api/private", "index.html.br"];
      await writeShellWorker(directory, files);
      const first = await readFile(join(directory, "sw.js"), "utf8");
      expect(first).toContain('"url":"/index.html"');
      expect(first).not.toContain("api/private");
      expect(first).not.toContain("__PRECACHE__");
      await writeShellWorker(directory, files);
      expect(await readFile(join(directory, "sw.js"), "utf8")).toBe(first);
      await writeFile(join(directory, "index.html"), "<html>Build B</html>");
      await writeShellWorker(directory, files);
      expect(await readFile(join(directory, "sw.js"), "utf8")).not.toBe(first);
      await expect(writeShellWorker(directory, [])).rejects.toThrow("Missing shell index.html");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
