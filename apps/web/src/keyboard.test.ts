import { describe, expect, it } from "vitest";
import {
  type Command,
  filterCommands,
  isShortcutEvent,
  messageCursorIndex,
  nextMessageIndex,
} from "./keyboard";

describe("mail keyboard safety", () => {
  const plain = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
  };
  it("ignores browser modifiers, held keys, and input composition", () => {
    expect(isShortcutEvent(plain)).toBe(true);
    for (const key of Object.keys(plain))
      expect(isShortcutEvent({ ...plain, [key]: true })).toBe(false);
  });
  it("starts at the appropriate end and never wraps past a loaded list", () => {
    expect(nextMessageIndex(0, -1, 1)).toBe(-1);
    expect(nextMessageIndex(3, -1, 1)).toBe(0);
    expect(nextMessageIndex(3, -1, -1)).toBe(2);
    expect(nextMessageIndex(3, 0, -1)).toBe(0);
    expect(nextMessageIndex(3, 2, 1)).toBe(2);
    expect(nextMessageIndex(3, 1, 1)).toBe(2);
  });
  it("filters by every word in a label or group, regardless of case", () => {
    const commands = [
      { id: "archive", label: "Archive message", group: "Message" },
      { id: "inbox", label: "Go to Important inbox", group: "Navigation" },
    ] as Command[];
    expect(filterCommands(commands, "  IMPORTANT nav  ").map((item) => item.id)).toEqual(["inbox"]);
    expect(filterCommands(commands, "archive").map((item) => item.id)).toEqual(["archive"]);
    expect(filterCommands(commands, "unknown")).toEqual([]);
    expect(filterCommands(commands, "")).toEqual(commands);
  });
  it("keeps Enter and j/k on the focused conversation when its representative changes", () => {
    const messages = [
      { id: "unrelated", threadId: "first-thread" },
      { id: "older-visible-message", threadId: "focused-thread" },
      { id: "next", threadId: "last-thread" },
    ];
    const cursor = messageCursorIndex(messages, "archived-message", "focused-thread");
    expect(messages[cursor]?.id).toBe("older-visible-message");
    expect(nextMessageIndex(messages.length, cursor, 1)).toBe(2);
    expect(nextMessageIndex(messages.length, cursor, -1)).toBe(0);
    expect(messageCursorIndex(messages, "next", "focused-thread")).toBe(2);
    expect(messageCursorIndex(messages, null, "removed-thread")).toBe(-1);
  });
});
