import type { RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createMemo } from "solid-js";
import { unified } from "unified";

function readerHtml(text: string) {
  const processor = unified().use(remarkParse).use(remarkRehype);
  const tree = processor.runSync(processor.parse(text));
  const clean = (nodes: RootContent[]): RootContent[] =>
    nodes.flatMap<RootContent>((node) => {
      if (node.type !== "element") return [node];
      if (node.tagName === "img") return [];
      node.children = clean(node.children) as typeof node.children;
      if (node.tagName === "a") {
        const href = String(node.properties.href ?? "");
        if (!/^(https?:\/\/|mailto:)/i.test(href)) return node.children;
        node.properties = { href, title: href, target: "_blank", rel: ["noopener", "noreferrer"] };
      }
      return [node];
    });
  tree.children = clean(tree.children);
  return toHtml(tree);
}
export function ReaderText(props: { text: string }) {
  const html = createMemo(() => readerHtml(props.text));
  return <div class="plain-body markdown-body" innerHTML={html()} />;
}
