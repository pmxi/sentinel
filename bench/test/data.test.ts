import { describe, expect, it } from "vitest";
import {
  generateMessages,
  INBOX_THREAD_SIZES,
  parseSeed,
  randomGenerator,
  THREAD_SIZES,
  validateDatabaseUrl,
} from "../src/data.ts";

describe("benchmark seed", () => {
  it("matches message volumes, search fixtures, and classified inbox reader text", () => {
    const counts = {
      messages: 0,
      gmail: 0,
      inbox: 0,
      outbound: 0,
      attachments: 0,
      rare: 0,
      common: 0,
      unarchived: 0,
    };
    const tiers = [0, 0, 0, 0];
    const threads = new Set<string>();
    const inboxThreads = new Map<string, { count: number; latest: string }>();
    for (const row of generateMessages(1)) {
      counts.messages++;
      threads.add(row.thread_id);
      if (row.account_id.endsWith("000000000001")) counts.gmail++;
      if (row.direction === "outbound") counts.outbound++;
      if (!row.archived) counts.unarchived++;
      if (!row.archived && row.direction === "inbound") {
        counts.inbox++;
        const thread = inboxThreads.get(row.thread_id) ?? { count: 0, latest: "" };
        thread.count++;
        thread.latest = row.received_at > thread.latest ? row.received_at : thread.latest;
        inboxThreads.set(row.thread_id, thread);
        expect(row.tier).not.toBeNull();
        expect(row.text_body.length).toBeGreaterThan(0);
      }
      if (row.attachments.length) counts.attachments++;
      if (row.subject.includes("zanzibar")) counts.rare++;
      if (row.subject.includes("invoice")) counts.common++;
      if (row.tier !== null) tiers[row.tier] = (tiers[row.tier] ?? 0) + 1;
    }
    expect(counts).toEqual({
      messages: 23032,
      gmail: 17036,
      inbox: 1061,
      outbound: 755,
      attachments: 1288,
      rare: 25,
      common: 2000,
      unarchived: 1756,
    });
    expect(threads.size).toBe(20986);
    expect(tiers).toEqual([0, 1228, 6808, 1203]);
    expect(inboxThreads.size).toBe(928);
    const histogram = new Map<number, number>();
    for (const thread of inboxThreads.values())
      histogram.set(thread.count, (histogram.get(thread.count) ?? 0) + 1);
    expect([...histogram.entries()].sort((a, b) => a[0] - b[0])).toEqual(INBOX_THREAD_SIZES);
    const newest = [...inboxThreads.values()]
      .sort((a, b) => b.latest.localeCompare(a.latest))
      .slice(0, 75);
    expect(newest.reduce((sum, thread) => sum + thread.count, 0)).toBe(119);
    expect(Math.max(...newest.map((thread) => thread.count))).toBe(8);
  });
  it("requires an explicitly benchmark-named database", () => {
    expect(validateDatabaseUrl("postgres://localhost/sent_bench")).toContain("sent_bench");
    for (const value of [
      undefined,
      "",
      "postgres://localhost/sent",
      "postgres://localhost/sent_test",
      "https://localhost/sent_bench",
    ]) {
      expect(() => validateDatabaseUrl(value)).toThrow();
    }
  });
  it("validates the optional seed", () => {
    expect(parseSeed([])).toBe(1);
    expect(parseSeed(["--seed", "0"])).toBe(0);
    for (const args of [["--seed"], ["--seed", "NaN"], ["--seed", "4294967296"], ["--other", "1"]])
      expect(() => parseSeed(args)).toThrow();
  });
  it("is deterministic and varies with seed", () => {
    const a = randomGenerator(1);
    const b = randomGenerator(1);
    expect(Array.from({ length: 20 }, () => a())).toEqual(Array.from({ length: 20 }, () => b()));
    expect(generateMessages(1).next().value).toEqual(generateMessages(1).next().value);
    expect(generateMessages(1).next().value).not.toEqual(generateMessages(2).next().value);
  });
  it("matches the complete thread histogram", () => {
    expect(THREAD_SIZES.reduce((sum, [, count]) => sum + count, 0)).toBe(20986);
    expect(THREAD_SIZES.reduce((sum, [size, count]) => sum + size * count, 0)).toBe(23032);
  });
});
