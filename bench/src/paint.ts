import type { Selectors } from "./metrics.ts";

export type Condition = {
  kind: "list" | "reader" | "archive" | "search";
  subject?: string;
  term?: string;
  before?: string;
};
type Trigger = { type: "click" | "keydown" | "submit"; key?: string };
declare global {
  interface Window {
    __sentBench: {
      arm(condition: Condition, trigger: Trigger): void;
      result: number | null;
      startEpoch: number | null;
      endEpoch: number | null;
    };
  }
}

// Serialized by Playwright: keep this function independent of module scope.
export function installPaintObserver(selectors: Selectors) {
  let condition: Condition = { kind: "list" };
  let trigger: Trigger | null = null;
  let start: number | null = 0;
  let generation = 0;
  let pending = false;
  const normalize = (value: string) => value.trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, "");
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const done = () => {
    const rows = [...document.querySelectorAll(selectors.rows)];
    if (condition.kind === "list") return rows.length >= 10;
    if (condition.kind === "archive")
      return !rows.some(
        (row) => normalize(text(row.querySelector(selectors.rowSubject))) === condition.subject,
      );
    if (condition.kind === "search") {
      const first = rows[0];
      return (
        rows.length > 0 &&
        text(first ?? null) !== condition.before &&
        text(first ?? null)
          .toLowerCase()
          .includes(condition.term ?? "")
      );
    }
    const body = document.querySelector(selectors.body);
    const frame = body?.querySelector("iframe");
    let hasBody = Boolean(text(body ?? null));
    if (frame) {
      try {
        hasBody = Boolean(frame.contentDocument?.body?.textContent?.trim());
      } catch {
        hasBody = false;
      }
    }
    return (
      normalize(text(document.querySelector(selectors.readerSubject))) === condition.subject &&
      hasBody
    );
  };
  const check = () => {
    if (pending || start === null || window.__sentBench.result !== null || !done()) return;
    pending = true;
    const version = generation;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        pending = false;
        if (version === generation && start !== null && done()) {
          window.__sentBench.result = performance.now() - start;
          window.__sentBench.endEpoch = performance.timeOrigin + start + window.__sentBench.result;
        }
      }),
    );
  };
  window.__sentBench = {
    result: null,
    startEpoch: performance.timeOrigin,
    endEpoch: null,
    arm(next, event) {
      generation++;
      condition = next;
      trigger = event;
      start = null;
      pending = false;
      this.result = null;
      this.startEpoch = null;
      this.endEpoch = null;
    },
  };
  for (const type of ["click", "keydown", "submit"]) {
    document.addEventListener(
      type,
      (event) => {
        if (!trigger || start !== null || trigger.type !== event.type) return;
        if (trigger.key && (event as KeyboardEvent).key !== trigger.key) return;
        start = event.timeStamp;
        window.__sentBench.startEpoch = performance.timeOrigin + start;
        check();
      },
      true,
    );
  }
  new MutationObserver(check).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  document.addEventListener("load", check, true);
  document.addEventListener("DOMContentLoaded", check);
}
