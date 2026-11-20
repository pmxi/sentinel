import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDiagnostics } from "../src/diagnostics.ts";
import { DEFAULT_SELECTORS } from "../src/metrics.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sent-bench-diagnostics-"));
  directories.push(directory);
  const handlers = new Map<string, (event: unknown) => void>();
  const dom = { history: [], atTimeout: { subjects: [] } };
  const page = {
    on: vi.fn((event: string, handler: (event: unknown) => void) => handlers.set(event, handler)),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(dom),
  };
  const capture = await installDiagnostics(page as unknown as Page, DEFAULT_SELECTORS);
  const prefix = join(directory, "sample");
  return { page, handlers, dom, capture, prefix };
}

describe("failure evidence", () => {
  it("saves an empty network sequence and DOM snapshot with the screenshot", async () => {
    const { page, dom, capture, prefix } = await fixture();
    await capture(prefix);
    expect(page.screenshot).toHaveBeenCalledWith({ path: `${prefix}.png`, fullPage: true });
    expect(JSON.parse(await readFile(`${prefix}.json`, "utf8"))).toEqual({ dom, network: [] });
  });

  it("preserves the request/response sequence and only the mail state needed for diagnosis", async () => {
    const { handlers, capture, prefix } = await fixture();
    const request = {
      method: () => "GET",
      url: () => "http://localhost/api/messages",
      postData: () => null,
    };
    handlers.get("request")?.(request);
    handlers.get("response")?.({
      status: () => 200,
      url: request.url,
      request: () => request,
      json: async () => ({
        messages: [
          {
            id: "fake",
            subject: "Synthetic mail",
            archived: false,
            read: false,
            htmlBody: "omitted",
          },
        ],
      }),
    });
    handlers.get("requestfinished")?.(request);
    await capture(prefix);
    const { network } = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
    expect(network.map((entry: { event: string }) => entry.event)).toEqual([
      "request",
      "response",
      "finished",
    ]);
    expect(network[1].payload).toEqual([
      { id: "fake", subject: "Synthetic mail", archived: false, read: false },
    ]);
  });

  it("tolerates unavailable response bodies and surfaces screenshot errors", async () => {
    const { page, handlers, capture, prefix } = await fixture();
    handlers.get("response")?.({
      status: () => 500,
      url: () => "http://localhost/api/threads/fake",
      request: () => ({ method: () => "GET" }),
      json: async () => {
        throw new Error("Not JSON");
      },
    });
    await capture(prefix);
    const { network } = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
    expect(network[0]).toMatchObject({ event: "response", status: 500 });
    page.screenshot.mockRejectedValueOnce(new Error("Page closed"));
    await expect(capture(prefix)).rejects.toThrow("Page closed");
  });
});
