import { Command as CommandIcon, Search } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCompose } from "./compose";
import { type Command, filterCommands, isShortcutEvent, isTypingTarget } from "./keyboard";

type CommandContextValue = {
  register(scope: string, commands: () => Command[]): () => void;
  refresh(): void;
  forwardKey(event: KeyboardEvent): void;
  openPalette(): void;
};
const CommandContext = createContext<CommandContextValue | null>(null);

export function useCommandPalette() {
  const context = useContext(CommandContext);
  if (!context) throw new Error("Command context is unavailable");
  return context;
}

export function useCommands(scope: string, commands: Command[]) {
  const { register, refresh } = useCommandPalette();
  const latest = useRef(commands);
  latest.current = commands;
  useEffect(() => register(scope, () => latest.current), [register, scope]);
  // Keep open palette labels/availability current without re-registering callbacks.
  const signature = JSON.stringify(commands.map(({ run: _run, ...metadata }) => metadata));
  useEffect(() => {
    if (signature) refresh();
  }, [refresh, signature]);
}

// Original HTML lives in a same-origin sandbox. Its keyboard events do not
// bubble to the app window, so attach the same guarded dispatcher to that window.
export function useFrameCommands(frame: RefObject<HTMLIFrameElement | null>) {
  const { forwardKey } = useCommandPalette();
  useEffect(() => {
    const element = frame.current;
    let frameWindow: Window | null = null;
    const attach = () => {
      frameWindow?.removeEventListener("keydown", forwardKey);
      frameWindow = element?.contentWindow ?? null;
      frameWindow?.addEventListener("keydown", forwardKey);
    };
    element?.addEventListener("load", attach);
    attach();
    return () => {
      element?.removeEventListener("load", attach);
      frameWindow?.removeEventListener("keydown", forwardKey);
    };
  }, [forwardKey, frame]);
}

export function CommandProvider({ children }: { children: ReactNode }) {
  const registry = useRef(new Map<string, () => Command[]>());
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState(false);
  const [, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const compose = useCompose();
  const dispatch = useRef<(event: KeyboardEvent) => void>(() => {});
  const forwardKey = useCallback((event: KeyboardEvent) => dispatch.current(event), []);
  const register = useCallback((scope: string, commands: () => Command[]) => {
    registry.current.set(scope, commands);
    return () => {
      registry.current.delete(scope);
    };
  }, []);
  const getCommands = useCallback(
    () => [...registry.current.values()].flatMap((read) => read()),
    [],
  );
  const context = useMemo(
    () => ({ register, refresh, forwardKey, openPalette: () => setOpen(true) }),
    [register, refresh, forwardKey],
  );

  useEffect(() => {
    let prefixUntil = 0;
    let timer = 0;
    const resetPrefix = () => {
      prefixUntil = 0;
      setPrefix(false);
      window.clearTimeout(timer);
    };
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || compose.isOpen) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        resetPrefix();
        setOpen((value) => !value);
        return;
      }
      if (open || !isShortcutEvent(event) || isTypingTarget(event.target)) {
        resetPrefix();
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      // Enter on another control must keep its native click/submit behavior.
      if (
        key === "Enter" &&
        event.target instanceof Element &&
        event.target.closest("button:not(.message-row), a, summary")
      )
        return;
      if (key === "?" && !prefixUntil) {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (key === "g" && !event.shiftKey) {
        event.preventDefault();
        prefixUntil = Date.now() + 1200;
        setPrefix(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(resetPrefix, 1200);
        return;
      }
      const shortcut = prefixUntil > Date.now() ? `g ${key}` : key;
      resetPrefix();
      const command = getCommands().find((item) => item.keys.includes(shortcut) && !item.disabled);
      if (command) {
        event.preventDefault();
        command.run();
      }
    };
    window.addEventListener("keydown", listener);
    dispatch.current = listener;
    window.addEventListener("blur", resetPrefix);
    return () => {
      window.removeEventListener("keydown", listener);
      dispatch.current = () => {};
      window.removeEventListener("blur", resetPrefix);
      window.clearTimeout(timer);
    };
  }, [compose.isOpen, getCommands, open]);

  return (
    <CommandContext.Provider value={context}>
      {children}
      {prefix && (
        <div className="shortcut-prefix" role="status">
          <kbd>g</kbd> then <kbd>i</kbd> Important · <kbd>u</kbd> Updates · <kbd>l</kbd> Low
          priority · <kbd>a</kbd> All mail
        </div>
      )}
      {open && <CommandPalette commands={getCommands()} close={() => setOpen(false)} />}
    </CommandContext.Provider>
  );
}

function CommandPalette({ commands, close }: { commands: Command[]; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const groups = ["Message", "Mail", "Navigation"] as const;
  const results = filterCommands(
    [...commands].sort((left, right) => groups.indexOf(left.group) - groups.indexOf(right.group)),
    query,
  );
  const available = results.filter((command) => !command.disabled);
  const selected = available[active] ?? available[0];
  const restoreFocus = useCallback(() => {
    // Restore the editing caret only after removal from the modal top layer.
    window.requestAnimationFrame(() => {
      if (dialog.current?.open || !origin.current?.isConnected) return;
      origin.current.blur();
      origin.current.focus();
    });
  }, []);
  useEffect(() => {
    const element = dialog.current;
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    // Let showModal remember the originating control before focusing search.
    search.current?.focus();
    return () => {
      if (element?.open) {
        element.close();
        restoreFocus();
      }
    };
  }, [restoreFocus]);
  useEffect(() => {
    if (selected)
      document.getElementById(`command-${selected.id}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const dismiss = (restore = true) => {
    dialog.current?.close();
    close();
    if (restore) restoreFocus();
  };
  const execute = (command: Command) => {
    if (command.disabled) return;
    // Restore focus before an action deliberately focuses search/composer.
    dismiss(false);
    command.run();
  };
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-labelledby="command-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dismiss();
        }
      }}
      onKeyDown={(event) => {
        if (event.repeat || event.nativeEvent.isComposing) {
          if (event.key === "Enter" && event.repeat) event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setActive((value) =>
            available.length
              ? (value + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length
              : 0,
          );
        } else if (
          event.key === "Enter" &&
          event.target instanceof Element &&
          !event.target.closest(".command-heading")
        ) {
          event.preventDefault();
          if (selected) execute(selected);
        }
      }}
    >
      <div className="command-card">
        <header className="command-heading">
          <CommandIcon size={16} />
          <h2 id="command-title">Commands & shortcuts</h2>
          <button onClick={() => dismiss()} aria-label="Close command palette">
            <kbd>Esc</kbd>
          </button>
        </header>
        <div className="command-search">
          <Search size={19} />
          <input
            ref={search}
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-activedescendant={selected ? `command-${selected.id}` : undefined}
            placeholder="What would you like to do?"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </div>
        <div id="command-results" className="command-results" role="listbox" aria-label="Commands">
          {(["Message", "Mail", "Navigation"] as const).map((group) => {
            const items = results.filter((command) => command.group === group);
            return (
              items.length > 0 && (
                <fieldset aria-label={group} key={group}>
                  <legend className="command-group">{group}</legend>
                  {items.map((command) => (
                    <button
                      key={command.id}
                      tabIndex={-1}
                      id={`command-${command.id}`}
                      role="option"
                      aria-selected={command.id === selected?.id}
                      aria-disabled={command.disabled || undefined}
                      className={`command-option ${command.id === selected?.id ? "active" : ""}`}
                      onMouseMove={() => {
                        const index = available.indexOf(command);
                        if (index >= 0) setActive(index);
                      }}
                      onClick={() => execute(command)}
                    >
                      <span>
                        {command.label}
                        {command.disabled && <small>Not available right now</small>}
                      </span>
                      <ShortcutKeys keys={command.keys[0] ?? ""} />
                    </button>
                  ))}
                </fieldset>
              )
            );
          })}
          {results.length === 0 && (
            <div className="command-empty">No commands found. Try “compose” or “inbox”.</div>
          )}
        </div>
        <footer className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to navigate <kbd>↵</kbd> to run
          </span>
          <span>Shortcuts pause while typing</span>
        </footer>
      </div>
    </dialog>
  );
}

function ShortcutKeys({ keys }: { keys: string }) {
  return (
    <span className="shortcut-keys">
      {keys.split(" ").map((key) => (
        <kbd key={key}>{key === "Escape" ? "Esc" : key === "Enter" ? "↵" : key}</kbd>
      ))}
    </span>
  );
}
