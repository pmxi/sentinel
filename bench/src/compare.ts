import { readFile } from "node:fs/promises";
import { ACTIONS, percentile, type Results, valuesFor } from "./metrics.ts";

const [aPath, bPath, ...extra] = process.argv.slice(2);
if (!aPath || !bPath || extra.length)
  throw new Error("Usage: pnpm bench:compare <a/results.json> <b/results.json>");
const a = JSON.parse(await readFile(aPath, "utf8")) as Results;
const b = JSON.parse(await readFile(bPath, "utf8")) as Results;
if (
  !a.metadata?.profiles ||
  !b.metadata?.profiles ||
  !Array.isArray(a.samples) ||
  !Array.isArray(b.samples)
)
  throw new Error("Invalid benchmark results");
console.log(
  `Comparison: ${a.metadata.label} (A) → ${b.metadata.label} (B). Milliseconds; ratio B/A (<1 is faster).`,
);
console.log(
  "| Action | Profile | A median | B median | B/A | A req / KB | B req / KB |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const action of ACTIONS) {
  for (const profile of new Set([
    ...Object.keys(a.metadata.profiles),
    ...Object.keys(b.metadata.profiles),
  ])) {
    const av = percentile(valuesFor(a, action, profile), 0.5);
    const bv = percentile(valuesFor(b, action, profile), 0.5);
    const network = (results: Results) => {
      const requests = percentile(valuesFor(results, action, profile, "requests"), 0.5);
      const bytes = percentile(valuesFor(results, action, profile, "transferredBytes"), 0.5);
      return requests === null || bytes === null
        ? "—"
        : `${requests.toFixed(1)} / ${(bytes / 1000).toFixed(1)}`;
    };
    console.log(
      `| ${action} | ${profile} | ${av?.toFixed(1) ?? "—"} | ${bv?.toFixed(1) ?? "—"} | ${av && bv !== null ? (bv / av).toFixed(2) : "—"} | ${network(a)} | ${network(b)} |`,
    );
  }
}
console.log(
  `Failures (including warmups): A=${a.failures?.length ?? 0}, B=${b.failures?.length ?? 0}`,
);
