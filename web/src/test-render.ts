import type { Component, JSX } from "solid-js";
import { render } from "solid-js/web";

export function createElement<Props extends object>(
  component: Component<Props>,
  props: Props,
): () => JSX.Element {
  return () => component(props);
}

export function renderToStaticMarkup(element: () => JSX.Element): string {
  const container = document.createElement("div");
  const dispose = render(element, container);
  const html = container.innerHTML.replace(/<!--.*?-->/gs, "");
  dispose();
  return html;
}
