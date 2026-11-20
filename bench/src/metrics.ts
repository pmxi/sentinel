export const PROFILES = {
  local: { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  lan: { latency: 20, downloadThroughput: -1, uploadThroughput: -1 },
  broadband: { latency: 60, downloadThroughput: 50e6 / 8, uploadThroughput: 10e6 / 8 },
  far: { latency: 150, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8 },
  mobile: { latency: 300, downloadThroughput: 5e6 / 8, uploadThroughput: 1e6 / 8 },
} as const;
export const ACTIONS = [
  "cold_start",
  "inbox_load",
  "open_email",
  "next_email",
  "archive",
  "search_rare",
  "search_common",
] as const;
export type Action = (typeof ACTIONS)[number];
export type Profile = keyof typeof PROFILES;
export const DEFAULT_SELECTORS = {
  rows: "button.message-row",
  rowSubject: ".message-subject",
  readerSubject: ".conversation-heading h2",
  body: ".latest-message .email-body",
  search: 'input[aria-label="Search mail"]',
  nextKey: "j",
  archiveKey: "e",
  searchKey: "/",
  submitKey: "Enter",
};
export type Selectors = typeof DEFAULT_SELECTORS;
export type Sample = {
  profile: Profile;
  action: Action;
  iteration: number;
  warmup: boolean;
  ms: number | null;
  requests?: number | null;
  transferredBytes?: number | null;
  error?: string;
  evidence?: string;
};
export type Results = {
  metadata: {
    url: string;
    label: string;
    date: string;
    chromium: string;
    host: { cpu: string; cores: number; ramBytes: number; os: string };
    profiles: Partial<typeof PROFILES>;
    iterations: number;
    warmups: number;
    selectors: Selectors;
    timeoutMs: number;
    actions?: string[];
    diagnostics?: boolean;
  };
  samples: Sample[];
  failures: Sample[];
};
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lo = sorted[Math.floor(position)] as number;
  const hi = sorted[Math.ceil(position)] as number;
  return lo + (hi - lo) * (position % 1);
}
export function valuesFor(
  results: Results,
  action: Action,
  profile: string,
  metric: "ms" | "requests" | "transferredBytes" = "ms",
): number[] {
  return results.samples
    .filter((s) => s.action === action && s.profile === profile && !s.warmup && s.ms !== null)
    .map((s) => s[metric])
    .filter((value): value is number => typeof value === "number");
}
export function summary(results: Results): string {
  const profiles = Object.keys(results.metadata.profiles);
  return [
    `# ${results.metadata.label}`,
    "",
    "Milliseconds: median (p95). Failed samples excluded; see results.json. Two warmups discarded per action/profile.",
    "",
    `| Action | ${profiles.join(" | ")} |`,
    `| --- | ${profiles.map(() => "---:").join(" | ")} |`,
    ...ACTIONS.map(
      (action) =>
        `| ${action} | ${profiles
          .map((profile) => {
            const values = valuesFor(results, action, profile);
            const median = percentile(values, 0.5);
            return median === null
              ? "—"
              : `${median.toFixed(1)} (${percentile(values, 0.95)?.toFixed(1)})`;
          })
          .join(" | ")} |`,
    ),
    "",
    "Median HTTP requests / transferred KB (decimal, request + response headers and encoded bodies completed by paint). In-flight responses contribute no bytes.",
    "",
    `| Action | ${profiles.join(" | ")} |`,
    `| --- | ${profiles.map(() => "---:").join(" | ")} |`,
    ...ACTIONS.map(
      (action) =>
        `| ${action} | ${profiles
          .map((profile) => {
            const requests = percentile(valuesFor(results, action, profile, "requests"), 0.5);
            const bytes = percentile(valuesFor(results, action, profile, "transferredBytes"), 0.5);
            return requests === null || bytes === null
              ? "—"
              : `${requests.toFixed(1)} / ${(bytes / 1000).toFixed(1)}`;
          })
          .join(" | ")} |`,
    ),
    "",
    `Failures: ${results.failures.length} (including warmups).`,
    "",
  ].join("\n");
}
