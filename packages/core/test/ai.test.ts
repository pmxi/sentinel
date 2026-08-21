import { describe, expect, it } from "vitest";
import { ClassificationOutputSchema, embeddingFallbackInput } from "../src/ai.ts";

describe("classification output", () => {
  it("accepts the intentionally small contract", () => {
    expect(
      ClassificationOutputSchema.parse({ reasoning: "A professor requested a reply.", tier: 1 }),
    ).toEqual({
      reasoning: "A professor requested a reply.",
      tier: 1,
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
