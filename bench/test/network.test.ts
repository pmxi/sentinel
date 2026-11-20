import { describe, expect, it } from "vitest";
import { networkTotals } from "../src/network.ts";

describe("action HTTP accounting", () => {
  it("counts triggered requests, including those still in flight, but only completed bytes", () => {
    expect(
      networkTotals(
        [
          { start: 9, end: 15, bytes: 1000 },
          { start: 10, end: 12, bytes: 200 },
          { start: 11, end: 21, bytes: 500 },
          { start: 12 },
          { start: 20, end: 20, bytes: 100 },
          { start: 21, end: 22, bytes: 500 },
        ],
        10,
        20,
      ),
    ).toEqual({ requests: 4, transferredBytes: 300 });
  });
  it("handles empty, failed, and cached responses", () => {
    expect(networkTotals([], 10, 20)).toEqual({ requests: 0, transferredBytes: 0 });
    expect(networkTotals([{ start: 11 }, { start: 12, end: 13, bytes: 0 }], 10, 20)).toEqual({
      requests: 2,
      transferredBytes: 0,
    });
  });
});
