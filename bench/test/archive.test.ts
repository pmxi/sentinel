import type { APIRequestContext } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { ensureArchiveCapacity, sampleRowIndex } from "../src/archive.ts";

const rows = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ threadId: `fake-${start + index}` }));
const response = (messages: unknown[], nextCursor: string | null = null) => ({
  ok: () => true,
  json: async () => ({ messages, nextCursor }),
});
const url = new URL("http://localhost:3100");
const check = (get: ReturnType<typeof vi.fn>, iterations = 15, profiles = 5, next = true) =>
  ensureArchiveCapacity({ get } as unknown as APIRequestContext, url, iterations, profiles, next);

describe("archive capacity preflight", () => {
  it("allows default runs with enough inbox threads, following pagination", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(response(rows(0, 75), "next-page"))
      .mockResolvedValueOnce(response(rows(75, 66)));
    await expect(check(get)).resolves.toBeUndefined();
    expect(get.mock.calls.map(([href]) => href)).toEqual([
      "http://localhost:3100/api/messages?view=l1&limit=75",
      "http://localhost:3100/api/messages?view=l1&limit=75&cursor=next-page",
    ]);
    expect(sampleRowIndex(-2)).toBe(0);
    expect(sampleRowIndex(5)).toBe(49);
  });

  it("rejects excessive aggregate requests, counting warmups and reserving selectable rows", async () => {
    const get = vi.fn().mockResolvedValue(response(rows(0, 141)));
    await expect(check(get, 100)).rejects.toThrow(
      "510 requested archive attempts (including warmups) across 5 profiles require 561 inbox threads",
    );
    await expect(check(get, 17)).rejects.toThrow("but only 141 are available");
    await expect(check(get, 16)).resolves.toBeUndefined();
  });

  it("handles empty inboxes and counts distinct threads rather than duplicate rows", async () => {
    await expect(check(vi.fn().mockResolvedValue(response([])))).rejects.toThrow(
      "only 0 are available",
    );
    const get = vi
      .fn()
      .mockResolvedValueOnce(response(rows(0, 75), "duplicate-page"))
      .mockResolvedValueOnce(response(rows(0, 75)));
    await expect(check(get)).rejects.toThrow("only 75 are available");
  });

  it("stops once enough inventory is proven and supports smaller action/profile selections", async () => {
    const get = vi.fn().mockResolvedValue(response(rows(0, 18), "unneeded-page"));
    await expect(check(get, 1, 1, false)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP errors, malformed rows/responses and looping pagination", async () => {
    await expect(
      check(vi.fn().mockResolvedValue({ ok: () => false, status: () => 503 })),
    ).rejects.toThrow("HTTP 503");
    await expect(
      check(vi.fn().mockResolvedValue({ ok: () => true, json: async () => ({}) })),
    ).rejects.toThrow("invalid inbox pagination response");
    await expect(check(vi.fn().mockResolvedValue(response([{}])))).rejects.toThrow(
      "missing threadId",
    );
    await expect(check(vi.fn().mockResolvedValue(response([], "same-cursor")))).rejects.toThrow(
      "repeated inbox pagination cursor",
    );
  });
});
