import { Command as CommandIcon, Search } from "lucide-solid";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import { useCompose } from "./compose";
import { type Command, filterCommands, isShortcutEvent, isTypingTarget } from "./keyboard";
import { useNavigate } from "./router";
import { useMailSearch } from "./search";

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
export function useCommands(scope: string, commands: Accessor<Command[]>) {
  const { register, refresh } = useCommandPalette();
  onCleanup(register(scope, commands));
  // Keep open palette labels/availability current without re-registering callbacks.
  const signature = createMemo(() =>
    JSON.stringify(commands().map(({ run: _run, ...metadata }) => metadata)),
  );
  createEffect(() => {
    [signature()];
    const cleanup = untrack(() => {
      if (signature()) refresh();
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
}
// Original HTML lives in a same-origin sandbox. Its keyboard events do not
// bubble to the app window, so attach the same guarded dispatcher to that window.
export function useFrameCommands(frame: { current: HTMLIFrameElement | null }) {
  const { forwardKey } = useCommandPalette();
  createEffect(() => {
    [forwardKey, frame];
    const cleanup = untrack(() => {
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
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
}
export function CommandProvider(props: { children: JSX.Element }) {
  const registry = { current: new Map<string, () => Command[]>() };
  const [open, setOpen] = createSignal(false);
  const [prefix, setPrefix] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const refresh = () => setRevision((value) => value + 1);
  const compose = useCompose();
  const dispatch = { current: () => {} } as {
    current: (event: KeyboardEvent) => void;
  };
  const forwardKey = (event: KeyboardEvent) => dispatch.current(event);
  const register = (scope: string, commands: () => Command[]) => {
    registry.current.set(scope, commands);
    return () => {
      registry.current.delete(scope);
    };
  };
  const getCommands = () => {
    revision();
    return [...registry.current.values()].flatMap((read) => read());
  };
  const context = createMemo(() => ({
    register,
    refresh,
    forwardKey,
    openPalette: () => setOpen(true),
  }));
  createEffect(() => {
    [compose.isOpen, getCommands, open()];
    const cleanup = untrack(() => {
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
        if (open() || !isShortcutEvent(event) || isTypingTarget(event.target)) {
          resetPrefix();
          return;
        }
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
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
        const command = getCommands().find(
          (item) => item.keys.includes(shortcut) && !item.disabled,
        );
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
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  return (
    <>
      {
        <CommandContext.Provider value={context()}>
          {props.children}
          {prefix() && (
            <div class="shortcut-prefix" role="status">
              <kbd>g</kbd> then <kbd>i</kbd> Important · <kbd>u</kbd> Updates · <kbd>l</kbd> Low
              priority · <kbd>a</kbd> All mail
            </div>
          )}
          {open() && <CommandPalette commands={getCommands()} close={() => setOpen(false)} />}
        </CommandContext.Provider>
      }
    </>
  );
}
function CommandPalette(props: { commands: Command[]; close(): void }) {
  const dialog = { current: null } as {
    current: HTMLDialogElement | null;
  };
  const search = { current: null } as {
    current: HTMLInputElement | null;
  };
  const origin = { current: null } as {
    current: (HTMLElement | null) | null;
  };
  const [query, setQuery] = createSignal("");
  const mail = useMailSearch(query);
  const navigate = useNavigate();
  const [active, setActive] = createSignal(0);
  const groups = ["Message", "Mail", "Navigation"] as const;
  const matchingCommands = createMemo(() => filterCommands(props.commands, query()));
  const results = createMemo<Command[]>(() => [
    ...matchingCommands(),
    ...(mail.data?.messages ?? []).map((row) => ({
      id: `mail-${row.threadId}`,
      label: row.subject,
      group: "Mail" as const,
      keys: [],
      run: () =>
        navigate(`/search?q=${encodeURIComponent(query())}&message=${encodeURIComponent(row.id)}`),
    })),
  ]);
  const grouped = createMemo(() => {
    const text = query().trim().toLowerCase();
    const exact = matchingCommands().find(
      (command) => !command.disabled && command.label.toLowerCase() === text,
    );
    const order = exact
      ? [exact.group, ...groups.filter((group) => group !== exact.group)]
      : groups;
    return order.map((group) => {
      const items = results().filter((command) => command.group === group);
      return {
        group,
        items: exact?.group === group ? [exact, ...items.filter((item) => item !== exact)] : items,
      };
    });
  });
  const available = createMemo(() =>
    grouped().flatMap(({ items }) => items.filter((command) => !command.disabled)),
  );
  const selected = createMemo(() => available()[active()] ?? available()[0]);
  const restoreFocus = () => {
    // Restore the editing caret only after removal from the modal top layer.
    window.requestAnimationFrame(() => {
      if (dialog.current?.open || !origin.current?.isConnected) return;
      origin.current.blur();
      origin.current.focus();
    });
  };
  createEffect(() => {
    [restoreFocus];
    const cleanup = untrack(() => {
      const element = dialog.current;
      origin.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element?.showModal();
      search.current?.focus();
      return () => {
        if (element?.open) {
          element.close();
          restoreFocus();
        }
      };
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  createEffect(() => {
    [selected()];
    const cleanup = untrack(() => {
      if (selected())
        document.getElementById(`command-${selected().id}`)?.scrollIntoView({ block: "nearest" });
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  const dismiss = (restore = true) => {
    dialog.current?.close();
    props.close();
    if (restore) restoreFocus();
  };
  const execute = (command: Command) => {
    if (command.disabled) return;
    // Restore focus before an action deliberately focuses search/composer.
    dismiss(false);
    command.run();
  };
  return (
    <>
      {
        <dialog
          ref={(element) => {
            dialog.current = element;
          }}
          class="command-palette"
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
            if (event.repeat || event.isComposing) {
              if (event.key === "Enter" && event.repeat) event.preventDefault();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) =>
                available().length
                  ? (value + (event.key === "ArrowDown" ? 1 : -1) + available().length) %
                    available().length
                  : 0,
              );
            } else if (
              event.key === "Enter" &&
              event.target instanceof Element &&
              !event.target.closest(".command-heading")
            ) {
              event.preventDefault();
              if (selected()) execute(selected());
            }
          }}
        >
          <div class="command-card">
            <header class="command-heading">
              <CommandIcon size={16} />
              <h2 id="command-title">Commands & shortcuts</h2>
              <button onClick={() => dismiss()} aria-label="Close command palette">
                <kbd>Esc</kbd>
              </button>
            </header>
            <div class="command-search">
              <Search size={19} />
              <input
                ref={(element) => {
                  search.current = element;
                }}
                role="combobox"
                aria-label="Search commands"
                aria-expanded="true"
                aria-controls="command-results"
                aria-autocomplete="list"
                aria-activedescendant={selected() ? `command-${selected().id}` : undefined}
                placeholder="What would you like to do?"
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setActive(0);
                }}
              />
            </div>
            <div id="command-results" class="command-results" role="listbox" aria-label="Commands">
              {grouped().map(({ group, items }) => {
                return (
                  items.length > 0 && (
                    <fieldset aria-label={group}>
                      <legend class="command-group">{group}</legend>
                      {items.map((command) => (
                        <button
                          tabIndex={-1}
                          id={`command-${command.id}`}
                          role="option"
                          aria-selected={command.id === selected()?.id}
                          aria-disabled={command.disabled || undefined}
                          class={`command-option ${command.id === selected()?.id ? "active" : ""}`}
                          onMouseMove={() => {
                            const index = available().indexOf(command);
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
              {results().length === 0 && (
                <div class="command-empty" role="status">
                  {query().trim() && mail.isPending
                    ? "Searching mail…"
                    : "No commands found. Try “compose” or “inbox”."}
                </div>
              )}
            </div>
            <footer class="command-footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> to navigate <kbd>↵</kbd> to run
              </span>
              <span>Shortcuts pause while typing</span>
            </footer>
          </div>
        </dialog>
      }
    </>
  );
}
function ShortcutKeys(props: { keys: string }) {
  return (
    <>
      {
        <span class="shortcut-keys">
          {props.keys.split(" ").map((key) => (
            <kbd>{key === "Escape" ? "Esc" : key === "Enter" ? "↵" : key}</kbd>
          ))}
        </span>
      }
    </>
  );
}
