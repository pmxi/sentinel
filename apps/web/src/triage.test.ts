import { describe, expect, it } from "vitest";
import { nextMessageId } from "./triage";

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
