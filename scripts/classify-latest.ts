import "dotenv/config";
import { closeDb, env, MailRepository, SentServices } from "../packages/core/src/index.ts";

if (!env().OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
const accountIndex = process.argv.indexOf("--account");
const accountEmail = accountIndex >= 0 ? process.argv[accountIndex + 1] : undefined;
if (accountIndex >= 0 && !accountEmail) throw new Error("--account requires an email address");
const limitIndex = process.argv.indexOf("--limit");
const limit = Number(limitIndex >= 0 ? process.argv[limitIndex + 1] : 500);
if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit requires a positive integer");
const force = process.argv.includes("--force");

const repository = new MailRepository();
const services = new SentServices(repository);
const ids = force
  ? await repository.newestInbound(limit, accountEmail)
  : await repository.newestUnclassified(limit, accountEmail);
process.stdout.write(
  `Classifying ${ids.length} messages${accountEmail ? ` from ${accountEmail}` : ""}. ${
    force ? "Existing classifications will be replaced." : "Existing classifications are preserved."
  }\n`,
);

let completed = 0;
const failures: Array<{ id: string; error: string }> = [];
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
        failures.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        process.stderr.write(
          `Classification failed for ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }),
);
if (failures.length > 0) {
  process.stderr.write(`Classification failed for ${failures.length}/${ids.length} messages.\n`);
  process.exitCode = 1;
}
await closeDb();
