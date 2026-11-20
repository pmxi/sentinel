import { describe, expect, it } from "vitest";
import { replySeed } from "./compose";
import type { Account, MessageDetail } from "./shared";

const account = { id: "account", email: "login@example.edu" } as Account;
const message = {
  id: "message",
  direction: "outbound",
  subject: "A conversation",
  receivedAt: "2026-09-22T12:00:00Z",
  textBody: "Hello",
  from: [{ name: "Me", address: "my-alias@example.edu" }],
  to: [{ name: "Recipient", address: "recipient@example.com" }],
  cc: [
    { name: "Me", address: "my-alias@example.edu" },
    { name: "Login", address: "login@example.edu" },
  ],
} as MessageDetail;

describe("reply recipients", () => {
  it("replies to the recipient when reading one's own sent message", () => {
    expect(replySeed(message, account).to).toEqual(message.to);
  });
  it("excludes the login address and actual sending alias from reply-all", () => {
    expect(replySeed(message, account, true).to).toEqual(message.to);
  });
  it("replies to the sender for incoming messages", () => {
    const incoming = {
      ...message,
      direction: "inbound" as const,
      from: message.to,
      to: message.from,
    };
    expect(replySeed(incoming, account).to).toEqual(incoming.from);
  });
});
