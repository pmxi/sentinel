import type { ReplicaDetail, ReplicaRow } from "./replica-types";

export async function packBody(row: ReplicaRow) {
  if (typeof CompressionStream !== "function") return;
  const data = JSON.stringify([
    row.textBody,
    row.htmlBody,
    row.plainText === row.textBody ? 0 : row.plainText,
  ]);
  const bytes = new TextEncoder().encode(data);
  const packed = new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  return packed.byteLength < bytes.byteLength ? packed : undefined;
}
export async function unpackDetail(detail: ReplicaDetail | undefined) {
  if (!detail?.packedBody) return detail;
  const bytes = new Uint8Array(detail.packedBody);
  const json = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const [textBody, htmlBody, plainText] = JSON.parse(json);
  if (
    typeof textBody !== "string" ||
    (htmlBody !== null && typeof htmlBody !== "string") ||
    (plainText !== 0 && plainText !== null && typeof plainText !== "string")
  )
    throw new Error("Invalid cached body");
  return {
    message: {
      ...detail.message,
      textBody,
      htmlBody,
      plainText: plainText === 0 ? textBody : plainText,
    },
    hasBody: detail.hasBody,
  };
}
