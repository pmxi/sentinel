import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function writeShellWorker(directory: string, files: string[]) {
  if (!files.includes("index.html")) throw new Error("Missing shell index.html");
  const source = await readFile(new URL("./src/shell-worker.js", import.meta.url), "utf8");
  const entries = await Promise.all(
    files
      .filter(
        (name) => name === "index.html" || (name.startsWith("assets/") && !name.endsWith(".map")),
      )
      .sort()
      .map(async (name) => ({
        url: `/${name}`,
        digest: createHash("sha256")
          .update(await readFile(resolve(directory, name)))
          .digest("hex"),
      })),
  );
  const manifest = JSON.stringify(entries);
  const version = createHash("sha256").update(source).update(manifest).digest("hex");
  await writeFile(
    resolve(directory, "sw.js"),
    source
      .replace("__SHELL_CACHE__", JSON.stringify(`sent-shell-${version}`))
      .replace("__PRECACHE__", manifest),
  );
}
