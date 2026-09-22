import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tier } from "@sent/shared";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { env, requireConfig } from "./config.ts";

export const ClassificationOutputSchema = z.object({
  reasoning: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  plainText: z.string().max(20_000),
});

export type ClassificationOutput = { reasoning: string; tier: Tier; plainText: string };

export type ClassificationResult = ClassificationOutput & {
  model: string;
  promptVersion: string;
};

const EMBEDDING_FALLBACK_BYTES = 7_500;
const EMBEDDING_OMISSION = "\n\n[... middle omitted for embedding ...]\n\n";

const READER_URL = /https?:\/\/[^\s<>[\]"]+/g;

// The model chooses link labels, not opaque URL bytes. Markdown reference definitions are
// appended from the source after generation so tracking/sign-in tokens cannot be mistyped.
export function readerLinkReferences(message: string) {
  const urls = [...new Set(message.match(READER_URL) ?? [])];
  const definitions = new Map(urls.map((url, index) => [`sent-link-${index + 1}`, url]));
  const definition = (id: string, url: string) => `[${id}]: <${url}>`;
  return {
    input: urls.length
      ? `${message}\n\nSent link references (use these IDs for hyperlinks):\n${[...definitions].map(([id, url]) => definition(id, url)).join("\n")}`
      : message,
    finish(text: string): string {
      // Also reject invented or altered inline destinations if the model ignores the reference
      // instruction. Preserve the original view/previous rewrite on a failed generation.
      for (const url of text.match(READER_URL) ?? []) {
        if (!urls.includes(url) && !urls.includes(url.replace(/[).,;]+$/, "")))
          throw new Error("Reader rewrite contains a URL not present in the source");
      }
      if (/^\s*\[sent-link-\d+\]:/im.test(text))
        throw new Error("Reader rewrite must not supply its own link definitions");
      const used = new Set(
        [...text.matchAll(/\]\[(sent-link-\d+)\]/gi)].map((match) => match[1]?.toLowerCase()),
      );
      const links = [...used].map((id) => {
        const url = id && definitions.get(id);
        if (!id || !url) throw new Error("Reader rewrite contains an unknown link reference");
        return definition(id, url);
      });
      return links.length ? `${text.trim()}\n\n${links.join("\n")}` : text;
    },
  };
}

function utf8Prefix(text: string, byteLimit: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > byteLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8Suffix(text: string, byteLimit: number): string {
  let bytes = 0;
  const result: string[] = [];
  const characters = Array.from(text);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) continue;
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > byteLimit) break;
    result.push(character);
    bytes += characterBytes;
  }
  return result.reverse().join("");
}

export function embeddingFallbackInput(text: string): string {
  if (Buffer.byteLength(text) <= EMBEDDING_FALLBACK_BYTES) return text;
  const contentBytes = EMBEDDING_FALLBACK_BYTES - Buffer.byteLength(EMBEDDING_OMISSION);
  const prefixBytes = Math.floor(contentBytes * 0.72);
  return `${utf8Prefix(text, prefixBytes)}${EMBEDDING_OMISSION}${utf8Suffix(
    text,
    contentBytes - prefixBytes,
  )}`;
}

let promptCache: { text: string; version: string } | undefined;

export async function classificationPrompt(): Promise<{ text: string; version: string }> {
  if (!promptCache) {
    const candidates = [
      resolve(process.cwd(), "prompts/classify-v1.md"),
      resolve(process.cwd(), "../../prompts/classify-v1.md"),
    ];
    const path = candidates.find(existsSync) ?? candidates[0];
    if (!path) throw new Error("Classification prompt path could not be resolved");
    const text = await readFile(path, "utf8");
    const version = createHash("sha256").update(text).digest("hex").slice(0, 12);
    promptCache = { text, version };
  }
  return promptCache;
}

export interface IntelligenceService {
  classify(message: string): Promise<ClassificationResult>;
  embed(text: string): Promise<{ embedding: number[]; model: string }>;
}

export class OpenAIIntelligenceService implements IntelligenceService {
  private readonly client: OpenAI;

  constructor(apiKey = requireConfig("OPENAI_API_KEY")) {
    this.client = new OpenAI({ apiKey });
  }

  async classify(message: string): Promise<ClassificationResult> {
    const prompt = await classificationPrompt();
    const model = env().OPENAI_CLASSIFICATION_MODEL;
    const links = readerLinkReferences(message);
    const response = await this.client.responses.parse({
      model,
      instructions: prompt.text,
      input: links.input,
      reasoning: { effort: "xhigh" },
      store: false,
      text: { format: zodTextFormat(ClassificationOutputSchema, "email_classification") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no classification output");
    return {
      ...response.output_parsed,
      plainText: links.finish(response.output_parsed.plainText),
      model,
      promptVersion: prompt.version,
    };
  }

  async embed(text: string): Promise<{ embedding: number[]; model: string }> {
    const model = env().OPENAI_EMBEDDING_MODEL;
    // text-embedding-3-large has a smaller context than the classifier. Preserve headers and the
    // beginning/end of unusually large messages instead of allowing an oversized request to fail.
    const input =
      text.length <= 28_000
        ? text
        : `${text.slice(0, 20_000)}\n\n[... middle omitted for embedding ...]\n\n${text.slice(-8_000)}`;
    let response: Awaited<ReturnType<typeof this.client.embeddings.create>>;
    try {
      response = await this.client.embeddings.create({
        model,
        input,
        encoding_format: "float",
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/maximum context length|too many tokens/i.test(error.message)
      ) {
        throw error;
      }
      response = await this.client.embeddings.create({
        model,
        input: embeddingFallbackInput(text),
        encoding_format: "float",
      });
    }
    const embedding = response.data[0]?.embedding;
    if (!embedding) throw new Error("OpenAI returned no embedding");
    return { embedding, model };
  }
}

export class UnavailableIntelligenceService implements IntelligenceService {
  async classify(): Promise<ClassificationResult> {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  async embed(): Promise<{ embedding: number[]; model: string }> {
    throw new Error("OPENAI_API_KEY is not configured");
  }
}

export function createIntelligenceService(): IntelligenceService {
  return env().OPENAI_API_KEY
    ? new OpenAIIntelligenceService(env().OPENAI_API_KEY)
    : new UnavailableIntelligenceService();
}
