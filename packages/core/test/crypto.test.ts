import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.ts";

describe("secret encryption", () => {
  it("round trips and uses a random nonce", () => {
    const key = randomBytes(32).toString("base64");
    const first = encryptSecret("refresh token", key);
    const second = encryptSecret("refresh token", key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe("refresh token");
  });

  it("rejects the wrong key", () => {
    const encrypted = encryptSecret("secret", randomBytes(32).toString("base64"));
    expect(() => decryptSecret(encrypted, randomBytes(32).toString("base64"))).toThrow();
  });
});
