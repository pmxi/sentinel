import { describe, expect, it } from "vitest";
import { parseAddresses, sanitizeEmailHtml } from "../src/providers/normalize.ts";

describe("email normalization", () => {
  it("parses named and bare addresses", () => {
    expect(parseAddresses('Paras Mittal <paras@example.com>, "Ada L" <ada@example.org>')).toEqual([
      { name: "Paras Mittal", address: "paras@example.com" },
      { name: "Ada L", address: "ada@example.org" },
    ]);
  });

  it("removes executable markup while allowing ordinary remote images", () => {
    const result = sanitizeEmailHtml(
      '<script>alert(1)</script><img src="https://example.com/pixel"><a href="javascript:bad()">x</a>',
    );
    expect(result).not.toContain("script");
    expect(result).not.toContain("javascript:");
    expect(result).toContain("https://example.com/pixel");
  });
});
