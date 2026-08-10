import "dotenv/config";
import { closeDb, env, MailRepository, SentServices } from "../packages/core/src/index.ts";

if (!env().OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const accountIndex = process.argv.indexOf("--account");
const accountEmail = accountIndex >= 0 ? process.argv[accountIndex + 1] : undefined;
if (accountIndex >= 0 && !accountEmail) throw new Error("--account requires an email address");

const repository = new MailRepository();
const services = new SentServices(repository);
const ids = await repository.newestUnclassified(500, accountEmail);
process.stdout.write(
  `Classifying ${ids.length} messages${accountEmail ? ` from ${accountEmail}` : ""}. Existing classifications are preserved.\n`,
);

let completed = 0;
const queue = [...ids];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      try {
        await services.classifyMessage(id);
        completed += 1;
        if (completed % 10 === 0 || completed === ids.length)
          process.stdout.write(`Classified ${completed}/${ids.length}\n`);
      } catch (error) {
        process.stderr.write(
          `Classification failed for ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }),
);
await closeDb();
