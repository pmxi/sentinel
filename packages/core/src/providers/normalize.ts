import { createHash } from "node:crypto";
import type { MailAddress } from "@sent/shared";
import { convert } from "html-to-text";
import sanitizeHtml from "sanitize-html";

export function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function parseAddresses(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const pieces = value.match(/(?:[^,"<]|"[^"]*"|<[^>]*>)+/g) ?? [];
  return pieces.flatMap((piece) => {
    const emailMatch = piece.match(/<?([\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+)>?/i);
    if (!emailMatch?.[1]) return [];
    const rawName = piece
      .slice(0, emailMatch.index ?? 0)
      .trim()
      .replace(/^"|"$/g, "");
    return [{ name: rawName, address: emailMatch[1].toLowerCase() }];
  });
}

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "table",
      "tbody",
      "thead",
      "tfoot",
      "tr",
      "td",
      "th",
      "colgroup",
      "col",
      "style",
    ]),
    allowedAttributes: {
      "*": ["class", "dir", "lang", "style", "title"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "title"],
      table: ["border", "cellpadding", "cellspacing", "width", "align"],
      td: ["colspan", "rowspan", "width", "height", "align", "valign"],
      th: ["colspan", "rowspan", "width", "height", "align", "valign"],
      col: ["span", "width"],
    },
    allowedSchemes: ["http", "https", "mailto", "cid"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" },
      }),
    },
  });
}

export function textFromHtml(html: string): string {
  return convert(html, {
    selectors: [{ selector: "img", format: "skip" }],
    wordwrap: false,
  }).trim();
}

export function snippetFromText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function messageAnalysisText(message: {
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: Date | null;
  receivedAt: Date;
  textBody: string;
}): string {
  const address = (items: MailAddress[]) =>
    items.map((item) => (item.name ? `${item.name} <${item.address}>` : item.address)).join(", ");
  return [
    `Subject: ${message.subject}`,
    `From: ${address(message.from)}`,
    `To: ${address(message.to)}`,
    `Cc: ${address(message.cc)}`,
    `Date: ${(message.sentAt ?? message.receivedAt).toISOString()}`,
    "",
    message.textBody,
  ].join("\n");
}
