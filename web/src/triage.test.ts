import { describe, expect, it } from "vitest";
import { nextMessageId, visibleConversations } from "./triage";

describe("message auto-advance", () => {
  const messages = [{ id: "first" }, { id: "middle" }, { id: "last" }];
  it("opens the next message in the visible order", () => {
    expect(nextMessageId(messages, "first")).toBe("middle");
    expect(nextMessageId(messages, "middle")).toBe("last");
  });
  it("falls back to the previous message at the end", () => {
    expect(nextMessageId(messages, "last")).toBe("middle");
  });
  it("clears the reader for the last remaining message", () => {
    expect(nextMessageId([{ id: "only" }], "only")).toBeNull();
  });
  it("does not select an unrelated result when the message is no longer listed", () => {
    expect(nextMessageId(messages, "missing")).toBeNull();
    expect(nextMessageId([], "missing")).toBeNull();
  });
});

describe("optimistic conversation visibility", () => {
  const remaining = { id: "other", threadId: "other-thread", messageCount: 1 };
  const before = [{ id: "newest", threadId: "thread", messageCount: 3 }, remaining];
  const after = [{ id: "older", threadId: "thread", messageCount: 2 }, remaining];

  it("keeps a conversation hidden when a refreshed search changes its representative", () => {
    const hidden = new Set(["thread"]);
    expect(visibleConversations(before, hidden)).toEqual([remaining]);
    expect(visibleConversations(after, hidden)).toEqual([remaining]);
  });

  it("restores the original conversation and its summary fields after undo", () => {
    expect(visibleConversations(before, new Set())).toEqual(before);
  });
});
