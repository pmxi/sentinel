import type { APIRequestContext } from "playwright";

export const sampleRowIndex = (iteration: number) => ((iteration + 2) * 7) % 50;

export async function ensureArchiveCapacity(
  request: APIRequestContext,
  url: URL,
  iterations: number,
  profiles: number,
  includesNext: boolean,
) {
  const attempts = (iterations + 2) * profiles;
  const reserve = Math.max(
    10,
    ...Array.from(
      { length: iterations + 2 },
      (_, index) => sampleRowIndex(index - 2) + 1 + Number(includesNext),
    ),
  );
  const required = attempts + reserve;
  const endpoint = new URL("/api/messages?view=l1&limit=75", url);
  const threads = new Set<string>();
  const cursors = new Set<string>();
  while (threads.size < required) {
    const response = await request.get(endpoint.href, { timeout: 30000 });
    if (!response.ok()) throw new Error(`Archive capacity preflight: HTTP ${response.status()}`);
    const data = (await response.json()) as { messages?: unknown[]; nextCursor?: unknown };
    if (
      !data ||
      !Array.isArray(data.messages) ||
      !(data.nextCursor === null || typeof data.nextCursor === "string")
    )
      throw new Error("Archive capacity preflight: invalid inbox pagination response");
    for (const message of data.messages) {
      if (
        !message ||
        typeof message !== "object" ||
        !("threadId" in message) ||
        typeof message.threadId !== "string"
      )
        throw new Error("Archive capacity preflight: inbox row is missing threadId");
      threads.add(message.threadId);
    }
    if (!data.nextCursor) break;
    if (cursors.has(data.nextCursor))
      throw new Error("Archive capacity preflight: repeated inbox pagination cursor");
    cursors.add(data.nextCursor);
    endpoint.searchParams.set("cursor", data.nextCursor);
  }
  if (threads.size < required)
    throw new Error(
      `Archive capacity preflight: ${attempts} requested archive attempts (including warmups) across ${profiles} profiles require ${required} inbox threads (${reserve} reserved for varied row selection), but only ${threads.size} are available. Lower --iterations, select fewer --profiles, or reseed the benchmark DB.`,
    );
}
