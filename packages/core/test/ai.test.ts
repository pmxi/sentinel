import { describe, expect, it } from "vitest";
import {
  ClassificationOutputSchema,
  embeddingFallbackInput,
  readerLinkReferences,
} from "../src/ai.ts";

describe("reader link references", () => {
  it("restores exact long URLs without asking the model to reproduce them", () => {
    const url = `https://example.com/${"token_abc-".repeat(70)}?data=a%7Cb%7Cc&part=(1)#notes`;
    const links = readerLinkReferences(`Open meeting [${url}]\nSame meeting [${url}]`);
    expect(links.input).toContain(`[sent-link-1]: <${url}>`);
    expect(links.input).not.toContain("[sent-link-2]:");
    expect(links.finish("[Open meeting][sent-link-1]")).toBe(
      `[Open meeting][sent-link-1]\n\n[sent-link-1]: <${url}>`,
    );
  });

  it("only appends used references, once each", () => {
    const links = readerLinkReferences("https://example.com/one https://example.com/two");
    expect(links.finish("[Go][sent-link-2] and [again][sent-link-2]")).toBe(
      "[Go][sent-link-2] and [again][sent-link-2]\n\n[sent-link-2]: <https://example.com/two>",
    );
    expect(links.finish("No useful links.")).toBe("No useful links.");
  });

  it("rejects unknown references and altered URLs", () => {
    const links = readerLinkReferences("https://example.com/a?token=12345");
    expect(() => links.finish("[Go][sent-link-99]")).toThrow("unknown link reference");
    expect(() => links.finish("[Go](<https://example.com/a?token=1235>)")).toThrow(
      "URL not present in the source",
    );
    expect(() => links.finish("[Go](<https://example.com/a?token=1234>)")).toThrow(
      "URL not present in the source",
    );
    expect(() =>
      links.finish("[Go][sent-link-1]\n\n[sent-link-1]: <https://example.com/a?token=12345>"),
    ).toThrow("own link definitions");
    expect(links.finish("[Go](<https://example.com/a?token=12345>)")).toContain("token=12345");
  });
});

describe("classification output", () => {
  it("accepts the intentionally small contract", () => {
    expect(
      ClassificationOutputSchema.parse({
        reasoning: "A professor requested a reply.",
        tier: 1,
        plainText: "Please send me the revised lab by Friday.",
      }),
    ).toEqual({
      reasoning: "A professor requested a reply.",
      tier: 1,
      plainText: "Please send me the revised lab by Friday.",
    });
  });

  it("rejects extra tiers and missing reasoning", () => {
    expect(() => ClassificationOutputSchema.parse({ reasoning: "", tier: 4 })).toThrow();
  });
});

describe("embedding input", () => {
  it("keeps fallback input below the model token limit even for multibyte text", () => {
    const input = `${"start ".repeat(2_000)}${"😀".repeat(10_000)}${" end".repeat(2_000)}`;
    const fallback = embeddingFallbackInput(input);

    expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(7_500);
    expect(fallback).toContain("start");
    expect(fallback).toContain("end");
    expect(fallback).toContain("middle omitted for embedding");
  });
});
