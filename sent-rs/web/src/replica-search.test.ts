import type { ConversationSummary, SearchResponse } from "@sent/shared";
import { describe, expect, it } from "vitest";
import { ftsQuery, refineSearch } from "./replica-search";

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
});
