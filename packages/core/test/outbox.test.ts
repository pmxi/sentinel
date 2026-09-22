import { describe, expect, it, vi } from "vitest";
import type { IntelligenceService } from "../src/ai.ts";
import type { MailRepository } from "../src/db/repository.ts";
import type { MailProvider } from "../src/providers/types.ts";
import { SentServices } from "../src/services.ts";

function setup() {
  const payload: Record<string, unknown> = {
    draft: { to: [], cc: [], bcc: [], subject: "Test", body: "Test" },
  };
  const repository = {
    claimMutations: vi.fn(async () => [
      { id: "mutation", accountId: "account", action: "send", payload: { ...payload } },
    ]),
    getStoredAccount: vi.fn(async () => ({
      id: "account",
      provider: "gmail",
      email: "me@example.com",
    })),
    recordSendAttempt: vi.fn(async () => {
      payload.sendAttemptedAt = new Date().toISOString();
    }),
    completeMutation: vi.fn(async () => {}),
    failMutation: vi.fn(async () => {}),
  };
  const send = vi.fn<MailProvider["send"]>();
  const services = new SentServices(
    repository as unknown as MailRepository,
    {} as IntelligenceService,
  );
  vi.spyOn(services, "provider").mockReturnValue({ send } as unknown as MailProvider);
  return { services, send, repository };
}

describe("send outbox delivery safety", () => {
  it("does not send again after a lost delivery response", async () => {
    const { services, send, repository } = setup();
    send.mockImplementation(async (_account, _message, beforeSend) => {
      await beforeSend?.();
      throw new Error("Connection reset after dispatch");
    });
    await services.processOutbox();
    await services.processOutbox();
    expect(send).toHaveBeenCalledOnce();
    expect(repository.completeMutation).not.toHaveBeenCalled();
  });

  it("does not send again when recording a successful delivery fails", async () => {
    const { services, send, repository } = setup();
    send.mockImplementation(async (_account, _message, beforeSend) => {
      await beforeSend?.();
      return "sent-id";
    });
    repository.completeMutation.mockRejectedValueOnce(new Error("Database unavailable"));
    await services.processOutbox();
    await services.processOutbox();
    expect(send).toHaveBeenCalledOnce();
    expect(repository.recordSendAttempt).toHaveBeenCalledOnce();
  });

  it("can retry failures that occur before submitting the message", async () => {
    const { services, send, repository } = setup();
    send.mockRejectedValueOnce(new Error("Attachment upload failed"));
    send.mockImplementationOnce(async (_account, _message, beforeSend) => {
      await beforeSend?.();
      return "sent-id";
    });
    await services.processOutbox();
    await services.processOutbox();
    expect(send).toHaveBeenCalledTimes(2);
    expect(repository.recordSendAttempt).toHaveBeenCalledOnce();
    expect(repository.completeMutation).toHaveBeenCalledOnce();
  });
});
