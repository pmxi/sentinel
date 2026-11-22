import { describe, expect, it } from "vitest";
import { ftsQuery, refineSearch } from "./replica-search";
import type { ConversationSummary, SearchResponse } from "./shared";

describe("local search syntax and stable hybrid refinement", () => {
  it("prefixes only the final literal token and bounds pathological queries", () => {
    expect(ftsQuery('hello "world*')).toBe('"hello" AND "world"*');
    expect(ftsQuery("*** : ()")).toBe("");
    expect(ftsQuery("世界 café")).toBe('"世界" AND "café"*');
    expect(ftsQuery("x ".repeat(1000)).split(" AND ")).toHaveLength(32);
  });
  it("keeps visible order and selected message identity while appending hybrid-only matches", () => {
    const row = (id: string, threadId = id) =>
      ({ id, threadId, subject: id }) as ConversationSummary;
    const local: SearchResponse = { mode: "lexical", messages: [row("a"), row("b")] };
    const remote: SearchResponse = {
      mode: "hybrid",
      messages: [row("c"), row("other-b", "b"), row("a")],
    };
    expect(refineSearch(local, remote).messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(refineSearch(local, remote).mode).toBe("hybrid");
    expect(refineSearch(local, { mode: "lexical", messages: [] }).messages).toEqual(local.messages);
  });
  it("merges newest-first results by received date", () => {
    const row = (id: string, receivedAt: string) =>
      ({ id, threadId: id, receivedAt }) as ConversationSummary;
    const local: SearchResponse = { mode: "lexical", messages: [row("b", "2025-01-02")] };
    const remote: SearchResponse = {
      mode: "lexical",
      messages: [row("a", "2025-01-01"), row("c", "2025-01-03")],
    };
    expect(refineSearch(local, remote, "newest").messages.map((m) => m.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    const thread = (id: string, receivedAt: string) =>
      ({ id, threadId: "t", receivedAt }) as ConversationSummary;
    const older: SearchResponse = { mode: "lexical", messages: [thread("old", "2025-01-01")] };
    const newer: SearchResponse = { mode: "lexical", messages: [thread("new", "2025-01-05")] };
    expect(refineSearch(older, newer, "newest").messages.map((m) => m.id)).toEqual(["new"]);
    expect(refineSearch(newer, older, "newest").messages.map((m) => m.id)).toEqual(["new"]);
    expect(refineSearch(older, newer).messages.map((m) => m.id)).toEqual(["old"]);
  });
});
