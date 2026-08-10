import { z } from "zod";

const optionalCredential = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().url().default("postgres://sent:sent@localhost:5432/sent"),
  SENT_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  SENT_WEB_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  SENT_PASSWORD_HASH: optionalCredential,
  SESSION_SECRET: optionalCredential,
  TOKEN_ENCRYPTION_KEY: optionalCredential,
  OPENAI_API_KEY: optionalCredential,
  OPENAI_CLASSIFICATION_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  GOOGLE_CLIENT_ID: optionalCredential,
  GOOGLE_CLIENT_SECRET: optionalCredential,
  MICROSOFT_CLIENT_ID: optionalCredential,
  MICROSOFT_CLIENT_SECRET: optionalCredential,
  MICROSOFT_TENANT_ID: z.string().default("common"),
  MICROSOFT_MAIL_SEND_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WEB_DIST_PATH: z.string().default("apps/web/dist"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= EnvSchema.parse(process.env);
  return cached;
}

export function requireConfig<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env()[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return value as NonNullable<Env[K]>;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
