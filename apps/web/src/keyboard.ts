export type Command = {
  id: string;
  label: string;
  group: "Mail" | "Navigation" | "Message";
  keys: string[];
  run(): void;
  disabled?: boolean;
};

// Keep browser/OS shortcuts, IME input, and keys held down out of mail actions.
export function isShortcutEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "repeat" | "isComposing">,
) {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.isComposing;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
      ),
    )
  );
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().trim().split(/\s+/);
  return commands.filter((command) =>
    words.every((word) => `${command.label} ${command.group}`.toLowerCase().includes(word)),
  );
}

export function nextMessageIndex(length: number, index: number, direction: number): number {
  if (!length) return -1;
  if (index < 0) return direction > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, index + direction));
}
