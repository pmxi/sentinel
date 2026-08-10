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
});

export type ClassificationOutput = { reasoning: string; tier: Tier };

export type ClassificationResult = ClassificationOutput & {
  model: string;
  promptVersion: string;
};

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
    const response = await this.client.responses.parse({
      model,
      instructions: prompt.text,
      input: message,
      reasoning: { effort: "xhigh" },
      store: false,
      text: { format: zodTextFormat(ClassificationOutputSchema, "email_classification") },
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no classification output");
    return { ...response.output_parsed, model, promptVersion: prompt.version };
  }

  async embed(text: string): Promise<{ embedding: number[]; model: string }> {
    const model = env().OPENAI_EMBEDDING_MODEL;
    // text-embedding-3-large has a smaller context than the classifier. Preserve headers and the
    // beginning/end of unusually large messages instead of allowing an oversized request to fail.
    const input =
      text.length <= 28_000
        ? text
        : `${text.slice(0, 20_000)}\n\n[... middle omitted for embedding ...]\n\n${text.slice(-8_000)}`;
    const response = await this.client.embeddings.create({
      model,
      input,
      encoding_format: "float",
    });
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
