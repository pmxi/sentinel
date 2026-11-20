import { AlignLeft, Check, Ellipsis, Mail, Text } from "lucide-solid";
import { For, onCleanup, onMount, Show } from "solid-js";
import type { Tier } from "./shared";

export function ReaderMenu(props: {
  disabled: boolean;
  tier: Tier | null;
  onTier(tier: Tier): void;
  hasInsights: boolean;
  summaryOpen: boolean;
  onSummary(): void;
  hasPlainText: boolean;
  bodyView: "plain" | "original";
  onBodyView(): void;
  onDetails(): void;
}) {
  let menu!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  const choose = (action: () => void) => {
    menu.open = false;
    trigger.focus();
    action();
  };
  onMount(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      trigger.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    });
  });
  return (
    <details
      class="reader-more"
      ref={menu}
      onKeyDown={(event) => {
        if (menu.open) event.stopPropagation();
        if (event.key === "Escape" && menu.open) {
          event.preventDefault();
          event.stopPropagation();
          menu.open = false;
          trigger.focus();
        }
      }}
      onFocusOut={(event) => {
        if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget))
          menu.open = false;
      }}
    >
      <summary class="icon-button" ref={trigger} aria-label="More actions" title="More actions">
        <Ellipsis size={20} aria-hidden="true" />
      </summary>
      <div class="reader-more-panel">
        <Show when={props.hasInsights}>
          <button onClick={() => choose(props.onSummary)}>
            <AlignLeft size={16} aria-hidden="true" />
            {props.summaryOpen ? "Hide summary" : "Show summary"}
          </button>
        </Show>
        <Show when={props.hasPlainText}>
          <button onClick={() => choose(props.onBodyView)}>
            <Text size={16} aria-hidden="true" />
            {props.bodyView === "plain" ? "Show original" : "Show plain text"}
          </button>
        </Show>
        <fieldset disabled={props.disabled}>
          <legend>Move to</legend>
          <For
            each={
              [
                [1, "Important"],
                [2, "Updates"],
                [3, "Low priority"],
              ] as const
            }
          >
            {([tier, label]) => (
              <button
                aria-pressed={props.tier === tier}
                onClick={() => choose(() => props.onTier(tier))}
              >
                <span class={`priority-dot priority-${tier}`} aria-hidden="true" />
                {label}
                <Show when={props.tier === tier}>
                  <Check size={14} class="priority-check" aria-hidden="true" />
                </Show>
              </button>
            )}
          </For>
        </fieldset>
        <button onClick={() => choose(props.onDetails)}>
          <Mail size={16} aria-hidden="true" />
          Message details
        </button>
      </div>
    </details>
  );
}
