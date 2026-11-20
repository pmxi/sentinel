import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderMenu } from "./ReaderMenu";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
function menu(overrides: Partial<Parameters<typeof ReaderMenu>[0]> = {}) {
  const props = {
    disabled: false,
    tier: 1 as const,
    onTier: vi.fn(),
    hasInsights: true,
    summaryOpen: false,
    onSummary: vi.fn(),
    hasPlainText: true,
    bodyView: "plain" as const,
    onBodyView: vi.fn(),
    onDetails: vi.fn(),
    ...overrides,
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => createComponent(ReaderMenu, props), root);
  cleanups.push(() => {
    dispose();
    root.remove();
  });
  const details = root.querySelector("details") as HTMLDetailsElement;
  const button = (text: string) => {
    const element = [...root.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    if (!element) throw new Error(`Missing reader action: ${text}`);
    return element;
  };
  return { root, details, button, props };
}
describe("reader More actions", () => {
  it("keeps secondary controls closed until requested and preserves tier corrections", () => {
    const { details, button, props } = menu();
    expect(details.open).toBe(false);
    expect(button("Important").getAttribute("aria-pressed")).toBe("true");
    details.open = true;
    button("Low priority").click();
    expect(props.onTier).toHaveBeenCalledWith(3);
    expect(details.open).toBe(false);
  });
  it.each(["summary", "body"])(
    "dismisses Escape from %s without closing the conversation",
    (target) => {
      const { details } = menu();
      const back = vi.fn();
      const backShortcut = (event: KeyboardEvent) => {
        if (!event.defaultPrevented) back();
      };
      window.addEventListener("keydown", backShortcut);
      cleanups.push(() => window.removeEventListener("keydown", backShortcut));
      details.open = true;
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      (target === "body"
        ? document.body
        : (details.querySelector("summary") as HTMLElement)
      ).dispatchEvent(event);
      expect(details.open).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(back).not.toHaveBeenCalled();
    },
  );
  it("dismisses when clicking outside or tabbing out", () => {
    const { details } = menu();
    details.open = true;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(details.open).toBe(false);
  });
  it("keeps read-only disclosures available while tier mutations are unavailable", () => {
    const { root, details, button, props } = menu({ disabled: true });
    expect(root.querySelector("fieldset")?.disabled).toBe(true);
    details.open = true;
    button("Message details").click();
    expect(props.onDetails).toHaveBeenCalledOnce();
    expect(details.open).toBe(false);
  });
  it("only offers existing summaries and alternative body renditions", () => {
    const { root } = menu({ hasInsights: false, hasPlainText: false });
    expect(root.textContent).not.toContain("Show summary");
    expect(root.textContent).not.toContain("Show original");
    const { button, props } = menu({ summaryOpen: true, bodyView: "original" });
    button("Hide summary").click();
    button("Show plain text").click();
    expect(props.onSummary).toHaveBeenCalledOnce();
    expect(props.onBodyView).toHaveBeenCalledOnce();
  });
});
