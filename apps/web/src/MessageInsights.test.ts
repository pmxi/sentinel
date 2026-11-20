import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessagePreview, RankingReason, ReaderInsights } from "./MessageInsights";

const message = {
  aiSummary: "Send the revised lab by Friday.",
  snippet: "Hi there, hope your week is going well…",
  reasoning: "A professor directly requests a reply with a Friday deadline.",
  tier: 1 as const,
  modelTier: 1 as const,
};

describe("AI insights", () => {
  it("replaces boilerplate snippets with a labeled AI summary", () => {
    const html = renderToStaticMarkup(createElement(MessagePreview, { message }));
    expect(html).toContain('class="ai-label">AI</span>');
    expect(html).toContain(message.aiSummary);
    expect(html).not.toContain(message.snippet);
  });

  it.each([null, "", "   "])(
    "falls back to the original preview for missing summaries: %s",
    (aiSummary) => {
      const html = renderToStaticMarkup(
        createElement(MessagePreview, { message: { ...message, aiSummary } }),
      );
      expect(html).toContain(message.snippet);
      expect(html).not.toContain("ai-label");
    },
  );

  it("exposes a native keyboard-accessible disclosure without nested buttons", () => {
    const html = renderToStaticMarkup(createElement(RankingReason, { message }));
    expect(html).toContain("<details");
    expect(html).toContain("<summary>");
    expect(html).toContain("Why Important");
    expect(html).toContain(message.reasoning);
    expect(html).not.toContain("<button");
    expect(html).not.toContain('open=""');
  });

  it("distinguishes the user's choice from the AI's original suggestion", () => {
    const html = renderToStaticMarkup(
      createElement(RankingReason, { message: { ...message, tier: 2 } }),
    );
    expect(html).toContain("Your choice: Updates");
    expect(html).toContain("AI suggested Important");
    expect(html).not.toContain("Why Updates");
  });

  it("shows full summary and expanded reasoning at the top of the reader", () => {
    const html = renderToStaticMarkup(createElement(ReaderInsights, { message }));
    expect(html).toContain('aria-label="AI insights"');
    expect(html).toContain('open=""');
    expect(html).toContain(message.aiSummary);
    expect(html).toContain(message.reasoning);
  });

  it("does not show AI reasoning for unsorted or manually classified messages", () => {
    const unsorted = { ...message, aiSummary: null, modelTier: null, reasoning: null };
    expect(renderToStaticMarkup(createElement(ReaderInsights, { message: unsorted }))).toBe("");
    expect(renderToStaticMarkup(createElement(RankingReason, { message: unsorted }))).toBe("");
  });

  it("escapes model output instead of interpreting it as HTML", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderInsights, {
        message: { ...message, aiSummary: "<img src=x onerror=alert(1)>" },
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
