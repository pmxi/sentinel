import type { Page } from "playwright";

export function revealRows(input: {
  rows: string;
  index: number;
  next: boolean;
  indexed: boolean;
}) {
  const buttons = document.querySelectorAll<HTMLElement>(input.rows);
  let first: HTMLElement | undefined, last: HTMLElement | undefined;
  for (let i = 0; i < buttons.length; i++) {
    const row = buttons[i];
    if (!row) continue;
    const index = input.indexed ? Number(row.dataset.index) : i;
    if (index === input.index) first = row;
    if (index === input.index + (input.next ? 1 : 0)) last = row;
  }
  const anchor = first ?? buttons[0];
  const list = anchor?.closest<HTMLElement>(".message-list");
  if (!anchor || !list) return false;
  const viewport = list.getBoundingClientRect();
  if (!first || !last) {
    const item = anchor.closest<HTMLElement>(".message-list-item") ?? anchor;
    const rect = item.getBoundingClientRect();
    list.scrollTop +=
      rect.top - viewport.top + (input.index - Number(anchor.dataset.index)) * rect.height;
    return false;
  }
  const top = first.getBoundingClientRect().top,
    bottom = last.getBoundingClientRect().bottom;
  if (top < viewport.top - 1) {
    list.scrollTop += top - viewport.top;
    return false;
  }
  if (bottom > viewport.bottom + 1) {
    list.scrollTop += bottom - viewport.bottom;
    return false;
  }
  return true;
}

export async function prepareRows(page: Page, rows: string, index: number, next = false) {
  const indexed = (await page.locator(rows).first().getAttribute("data-index")) !== null;
  await page.waitForFunction(revealRows, { rows, index, next, indexed });
  const at = (position: number) =>
    indexed
      ? page.locator(rows).and(page.locator(`[data-index="${position}"]`))
      : page.locator(rows).nth(position);
  return { row: at(index), next: at(index + 1) };
}
