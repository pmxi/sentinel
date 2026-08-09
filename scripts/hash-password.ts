import { argv, stdin, stdout } from "node:process";
import argon2 from "argon2";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trimEnd();
}

const argument = argv[2];
if (!argument && stdin.isTTY) {
  stdout.write("Usage: pnpm sent:hash-password 'your password'\nOr pipe a password on stdin.\n");
  process.exit(1);
}
const password = argument ?? (await readStdin());
if (password.length < 10) {
  process.stderr.write("Use a password with at least 10 characters.\n");
  process.exit(1);
}
stdout.write(`${await argon2.hash(password, { type: argon2.argon2id })}\n`);
