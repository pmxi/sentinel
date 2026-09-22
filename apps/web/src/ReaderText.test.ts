import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReaderText } from "./ReaderText";

const render = (text: string) => renderToStaticMarkup(createElement(ReaderText, { text }));

describe("reader Markdown", () => {
  it("resolves generated reference links without displaying their definitions", () => {
    const html = render(
      "[Open meeting][sent-link-1]\n\n[sent-link-1]: <https://example.com/a?token=abc>",
    );
    expect(html).toContain('href="https://example.com/a?token=abc"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("Open meeting");
  });
  it("shows a short label while preserving the full signed destination", () => {
    const url = `https://example.com/meeting/${"x".repeat(500)}?token=a%2Fb%3D&part=(1)#notes`;
    const html = render(`[Open meeting](<${url}>)`);
    expect(html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(`title="${url.replaceAll("&", "&amp;")}"`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer">Open meeting</a>');
    expect(html.replace(/<[^>]+>/g, "")).toBe("Open meeting");
  });

  it("renders simple paragraphs, lists, emphasis, and mail links", () => {
    const html = render("Hi Paras,\nThanks!\n\n- **Due Friday**\n- [Reply](mailto:me@example.com)");
    expect(html).toContain("<p>Hi Paras,\nThanks!</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Due Friday</strong>");
    expect(html).toContain('href="mailto:me@example.com"');
  });

  it("leaves older plain text readable without a conversion layer", () => {
    expect(render("Meeting at 2 PM.\n\nBring your notes.")).toContain(
      "<p>Meeting at 2 PM.</p>\n<p>Bring your notes.</p>",
    );
  });

  it("does not render raw HTML or load Markdown images", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n![Tracking](https://example.com/pixel)\n\n**Safe text**',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.com/pixel");
    expect(html).toContain("<strong>Safe text</strong>");
  });

  it.each([
    "javascript:alert%281%29",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox%281%29",
    "file:///etc/passwd",
    "//example.com/path",
    "/api/oauth/gmail",
  ])("renders unsafe or relative link destinations as text: %s", (url) => {
    const html = render(`[Open](<${url}>)`);
    expect(html).not.toContain("href=");
    expect(html).toContain("Open");
  });
});
