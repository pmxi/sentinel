import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTORS,
  PROFILES,
  percentile,
  type Results,
  summary,
  valuesFor,
} from "../src/metrics.ts";

const fixture = (): Results => ({
  metadata: {
    url: "http://localhost:3100/",
    label: "test",
    date: "2026-11-20",
    chromium: "test",
    host: { cpu: "test", cores: 1, ramBytes: 1, os: "test" },
    profiles: { local: PROFILES.local },
    iterations: 3,
    warmups: 2,
    selectors: DEFAULT_SELECTORS,
    timeoutMs: 30000,
  },
  samples: [
    { profile: "local", action: "open_email", iteration: -1, warmup: true, ms: 1000 },
    {
      profile: "local",
      action: "open_email",
      iteration: 0,
      warmup: false,
      ms: 10,
      requests: 2,
      transferredBytes: 1000,
    },
    {
      profile: "local",
      action: "open_email",
      iteration: 1,
      warmup: false,
      ms: 20,
      requests: 4,
      transferredBytes: 3000,
    },
    {
      profile: "local",
      action: "open_email",
      iteration: 2,
      warmup: false,
      ms: null,
      error: "timeout",
    },
  ],
  failures: [],
});
describe("benchmark metrics", () => {
  it("interpolates median and p95 without mutating samples", () => {
    const values = [30, 10, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(29);
    expect(percentile([42], 0.95)).toBe(42);
    expect(values).toEqual([30, 10, 20]);
  });
  it("handles empty and failed samples, excluding warmups", () => {
    const results = fixture();
    results.failures = results.samples.filter((s) => Boolean(s.error));
    expect(valuesFor(results, "open_email", "local")).toEqual([10, 20]);
    expect(percentile([], 0.5)).toBeNull();
    expect(summary(results)).toContain("15.0 (19.5)");
    expect(summary(results)).toContain("3.0 / 2.0");
    expect(summary(results)).toContain("| cold_start | — |");
    expect(summary(results)).toContain("Failures: 1");
  });
  it("expresses throughput in bytes/sec and per-request latency in milliseconds", () => {
    expect(PROFILES.local.downloadThroughput).toBe(-1);
    expect(PROFILES.broadband.downloadThroughput).toBe(6250000);
    expect(PROFILES.far.latency).toBe(150);
    expect(PROFILES.mobile.uploadThroughput).toBe(125000);
  });
});
