import { describe, expect, it } from "vitest";
import { ClassificationOutputSchema } from "../src/ai.ts";

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
