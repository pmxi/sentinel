import { describe, expect, it } from "vitest";
import { type Command, filterCommands, isShortcutEvent, nextMessageIndex } from "./keyboard";

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
});
