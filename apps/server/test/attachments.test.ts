import type { SentServices } from "@sent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.ts";
import { createSessionToken } from "../src/auth.ts";

describe("outgoing attachment limits", () => {
  afterEach(() => vi.restoreAllMocks());

  async function send(sizes: number[]) {
    const draftId = "a4c8ef77-dc54-41aa-bd9a-c56819fd2d20";
    const repository = {
      getDraft: vi.fn().mockResolvedValue({ id: draftId, accountId: "microsoft-1" }),
      getStoredAccount: vi.fn().mockResolvedValue({ id: "microsoft-1", provider: "microsoft" }),
      enqueueSend: vi.fn().mockResolvedValue("mutation-1"),
    };
    const secret = "attachment-test-session-secret-long-enough";
    const app = await buildServer({
      services: { repository } as unknown as SentServices,
      sessionSecret: secret,
      passwordHash: "not-used",
      serveWeb: false,
    });
    try {
      const form = new FormData();
      for (const [index, size] of sizes.entries()) {
        form.append("attachment", new Blob([Buffer.alloc(size, 0x41)]), `file-${index}.bin`);
      }
      const request = new Request("http://localhost", { method: "POST", body: form });
      const response = await app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/send`,
        headers: {
          authorization: `Bearer ${await createSessionToken(secret)}`,
          "x-sent-request": "1",
          "content-type": request.headers.get("Content-Type") ?? "",
        },
        payload: Buffer.from(await request.arrayBuffer()),
      });
      return { response, repository };
    } finally {
      await app.close();
    }
  }

  it.each([[4 * 1024 * 1024], [2 * 1024 * 1024, 2 * 1024 * 1024], [20 * 1024 * 1024]])(
    "accepts Microsoft attachments totaling more than 3 MB (%j bytes)",
    async (...sizes) => {
      const { response, repository } = await send(sizes);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ mutationId: "mutation-1" });
      expect(repository.enqueueSend.mock.calls[0]?.[1]).toHaveLength(sizes.length);
    },
  );

  it.each([[20 * 1024 * 1024 + 1], [11 * 1024 * 1024, 10 * 1024 * 1024]])(
    "rejects more than 20 MB without queueing an email (%j bytes)",
    async (...sizes) => {
      const { response, repository } = await send(sizes);
      expect(response.statusCode).toBe(413);
      expect(response.json().error).toContain("20 MB");
      expect(repository.enqueueSend).not.toHaveBeenCalled();
    },
  );

  it("explains the file count limit without queueing an email", async () => {
    const { response, repository } = await send(Array(11).fill(1));
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toContain("at most 10 files");
    expect(repository.enqueueSend).not.toHaveBeenCalled();
  });
});
