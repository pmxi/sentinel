import type { ConversationSummary, SearchResponse, SearchSort } from "./shared";

export function ftsQuery(input: string) {
  const words =
    input
      .slice(0, 8192)
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 32) ?? [];
  return words
    .map((word, index) => `"${word.slice(0, 64)}"${index === words.length - 1 ? "*" : ""}`)
    .join(" AND ");
}

export function newestFirst(a: ConversationSummary, b: ConversationSummary) {
  return b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id);
}
export function refineSearch(
  local: SearchResponse,
  remote: SearchResponse,
  sort: SearchSort = "relevance",
): SearchResponse {
  const byThread = new Map(remote.messages.map((row) => [row.threadId, row]));
  const messages = local.messages.map((row) => {
    const updated = byThread.get(row.threadId);
    byThread.delete(row.threadId);
    return updated?.id === row.id ? updated : row;
  });
  const merged = [...messages, ...byThread.values()];
  return { mode: remote.mode, messages: sort === "newest" ? merged.sort(newestFirst) : merged };
}
