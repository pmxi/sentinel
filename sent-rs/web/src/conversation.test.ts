import { describe, expect, it } from "vitest";
import { MessageAttachments } from "./InboxPage";
import { createElement, renderToStaticMarkup } from "./test-render";

describe("conversation attachments", () => {
  it("links an earlier message's file through that message, not the latest reply", () => {
    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        message: {
          id: "earlier-message",
          attachments: [
            {
              id: "file/with+provider=id",
              filename: "offer.pdf",
              contentType: "application/pdf",
              size: 2048,
              inline: false,
              contentId: null,
            },
          ],
        },
      }),
    );
    expect(html).toContain("/api/messages/earlier-message/attachments/file%2Fwith%2Bprovider%3Did");
    expect(html).toContain("offer.pdf");
    expect(html).toContain("2 KB");
  });

  it("does not show an empty attachment section", () => {
    expect(
      renderToStaticMarkup(
        createElement(MessageAttachments, { message: { id: "no-files", attachments: [] } }),
      ),
    ).toBe("");
  });
});
