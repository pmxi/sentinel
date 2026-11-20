import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { CommandProvider, useCommandPalette, useCommands } from "./commands";
import type { Command } from "./keyboard";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("./compose", () => ({ useCompose: () => ({ isOpen: false }) }));
vi.mock("./router", () => ({ useNavigate: () => navigate }));
vi.mock("./search", () => ({
  useMailSearch: (query: () => string) => ({
    get data() {
      return query()
        ? { messages: [{ id: "message", threadId: "thread", subject: "Match mail" }] }
        : undefined;
    },
  }),
}));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  navigate.mockReset();
});

function palette(commands: Command[]) {
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  function Harness() {
    useCommands("test", () => commands);
    useCommandPalette().openPalette();
    return null;
  }
  dispose = render(
    () =>
      createComponent(CommandProvider, {
        get children() {
          return createComponent(Harness, {});
        },
      }),
    container,
  );
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw Error("Palette missing");
  input.value = "Match";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return { container, input };
}

it("traverses the rendered grouped order, skips disabled rows and executes the selected mail", async () => {
  const { container, input } = palette([
    { id: "navigation", label: "Match navigation", group: "Navigation", keys: [], run: vi.fn() },
    {
      id: "disabled",
      label: "Match disabled",
      group: "Mail",
      keys: [],
      disabled: true,
      run: vi.fn(),
    },
    { id: "message", label: "Match message", group: "Message", keys: [], run: vi.fn() },
  ]);
  await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]').length).toBe(4));
  const order = [...container.querySelectorAll('[role="option"]:not([aria-disabled="true"])')].map(
    (row) => row.id,
  );
  expect(order).toEqual(["command-message", "command-mail-thread", "command-navigation"]);
  expect(input.getAttribute("aria-activedescendant")).toBe(order[0]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(input.getAttribute("aria-activedescendant")).toBe(order[1]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(input.getAttribute("aria-activedescendant")).toBe(order[2]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(input.getAttribute("aria-activedescendant")).toBe(order[0]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  expect(input.getAttribute("aria-activedescendant")).toBe(order[2]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(navigate).toHaveBeenCalledWith("/search?q=Match&message=message");
});

it("has no active option or action for an empty command list", () => {
  const { container, input } = palette([]);
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(container.querySelectorAll('[role="option"]').length).toBe(0);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
