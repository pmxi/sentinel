// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { packBody, unpackDetail } from "./replica-body";
import type { ReplicaDetail, ReplicaRow } from "./replica-types";

afterEach(() => vi.unstubAllGlobals());
describe("lossless cached body compression", () => {
  it.each([null, "different plain text", 0])(
    "restores Unicode text and original HTML with plain text %s",
    async (plain) => {
      const textBody = "Unicode café 📬 ".repeat(2000),
        htmlBody = `<p>${textBody}</p>`,
        plainText = plain === 0 ? textBody : plain;
      const row = { textBody, htmlBody, plainText } as ReplicaRow,
        packedBody = await packBody(row);
      expect(packedBody?.byteLength).toBeLessThan(1000);
      const detail = {
        message: { ...row, id: "mail" },
        hasBody: true,
        packedBody,
      } as ReplicaDetail;
      expect(await unpackDetail(detail)).toEqual({
        message: { ...row, id: "mail" },
        hasBody: true,
      });
    },
  );
  it("leaves short or absent bodies untouched and tolerates missing compression support", async () => {
    const row = { textBody: "", htmlBody: null, plainText: null } as ReplicaRow;
    expect(await packBody(row)).toBeUndefined();
    expect(await unpackDetail(undefined)).toBeUndefined();
    const detail = { message: row, hasBody: false };
    expect(await unpackDetail(detail)).toBe(detail);
    vi.stubGlobal("CompressionStream", undefined);
    expect(await packBody(row)).toBeUndefined();
  });
  it("rejects corrupt stored bytes rather than publishing an empty quoted body", async () => {
    await expect(
      unpackDetail({
        message: {} as ReplicaRow,
        hasBody: true,
        packedBody: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow();
  });
});
