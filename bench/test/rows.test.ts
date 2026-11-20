import { afterEach, describe, expect, it, vi } from "vitest";
import { revealRows } from "../src/rows.ts";

afterEach(() => vi.unstubAllGlobals());
function fixture(indexed: boolean, indexes: number[]) {
  const list = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 240 }) };
  const rows = indexes.map((index) => {
    const row = {
      dataset: indexed ? { index: String(index) } : {},
      getBoundingClientRect: () => ({
        top: index * 120 - list.scrollTop,
        bottom: (index + 1) * 120 - list.scrollTop,
        height: 120,
      }),
      closest: (selector: string): unknown => (selector === ".message-list" ? list : row),
    };
    return row;
  });
  vi.stubGlobal("document", { querySelectorAll: () => rows });
  return list;
}
describe("untimed row preparation", () => {
  it("scrolls ordinary Node rows and their neighbor into view without index hooks", () => {
    const list = fixture(
      false,
      Array.from({ length: 75 }, (_, i) => i),
    );
    const input = { rows: "button.message-row", index: 49, next: true, indexed: false };
    expect(revealRows(input)).toBe(false);
    expect(list.scrollTop).toBe(49 * 120);
    expect(revealRows(input)).toBe(true);
  });
  it("requests a missing virtual row then waits for it and its neighbor to mount", () => {
    const list = fixture(true, [0, 1, 2]);
    const input = { rows: "button.message-row", index: 49, next: true, indexed: true };
    expect(revealRows(input)).toBe(false);
    expect(list.scrollTop).toBe(49 * 120);
    fixture(true, [48, 49, 50, 51]).scrollTop = list.scrollTop;
    expect(revealRows(input)).toBe(true);
  });
  it("waits rather than starting a timed action on an empty list", () => {
    fixture(true, []);
    expect(revealRows({ rows: "button.message-row", index: 0, next: false, indexed: true })).toBe(
      false,
    );
  });
});
