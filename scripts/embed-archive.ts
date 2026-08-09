import "dotenv/config";
import { closeDb, env, MailRepository, SentServices } from "../packages/core/src/index.ts";

if (!env().OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const repository = new MailRepository();
const services = new SentServices(repository);
let completed = 0;
let batch: string[];
let afterId: string | undefined;
do {
  batch = await repository.unembedded(100, afterId);
  const queue = [...batch];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) return;
        try {
          await services.embedMessage(id);
          completed += 1;
        } catch (error) {
          process.stderr.write(
            `Embedding failed for ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }),
  );
  afterId = batch.at(-1);
  if (batch.length) process.stdout.write(`Embedded ${completed} messages\n`);
} while (batch.length === 100);
await closeDb();
