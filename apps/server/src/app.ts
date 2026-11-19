import { access } from "node:fs/promises";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { databaseIsReady, env, requireConfig, SentServices } from "@sent/core";
import {
  DraftInputSchema,
  type HealthResponse,
  LoginSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MessageActionSchema,
  MessageListQuerySchema,
  ProviderSchema,
  SearchQuerySchema,
  TierOverrideSchema,
} from "@sent/shared";
import argon2 from "argon2";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bearerOrCookie,
  clearSessionCookie,
  createOAuthState,
  createSessionToken,
  setSessionCookie,
  verifyOAuthState,
  verifySessionToken,
} from "./auth.ts";

type ServerOptions = {
  services?: SentServices;
  passwordHash?: string;
  sessionSecret?: string;
  publicUrl?: string;
  webUrl?: string;
  serveWeb?: boolean;
};

const IdParamSchema = z.object({ id: z.string().uuid() });

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env().LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });
  const services = options.services ?? new SentServices();
  const repository = services.repository;
  const passwordHash = options.passwordHash ?? requireConfig("SENT_PASSWORD_HASH");
  const sessionSecret = options.sessionSecret ?? requireConfig("SESSION_SECRET");
  const publicUrl = options.publicUrl ?? env().SENT_PUBLIC_URL;
  const webUrl = options.webUrl ?? env().SENT_WEB_URL ?? publicUrl;
  const secureCookies = new URL(publicUrl).protocol === "https:";

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: MAX_ATTACHMENT_COUNT,
      parts: MAX_ATTACHMENT_COUNT,
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const pathname = request.url.split("?", 1)[0];
    const isPublic =
      pathname === "/api/health" ||
      pathname === "/api/auth/login" ||
      (pathname?.startsWith("/api/oauth/") && pathname.endsWith("/callback"));
    if (!isPublic && !(await verifySessionToken(bearerOrCookie(request), sessionSecret))) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && pathname !== "/api/auth/login") {
      if (request.headers["x-sent-request"] !== "1")
        return reply.code(403).send({ error: "Missing request protection header" });
    }
  });

  app.post(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute", ban: 3 } },
    },
    async (request, reply) => {
      const input = LoginSchema.parse(request.body);
      const valid = await argon2.verify(passwordHash, input.password);
      if (!valid) return reply.code(401).send({ error: "Incorrect password" });
      setSessionCookie(reply, await createSessionToken(sessionSecret), secureCookies);
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply, secureCookies);
    return { ok: true };
  });

  app.get("/api/auth/session", async () => ({ authenticated: true }));

  app.get("/api/health", async (): Promise<HealthResponse> => {
    const database = await databaseIsReady();
    if (!database)
      return {
        status: "degraded",
        database: false,
        workerHeartbeat: null,
        failedMutations: 0,
        classificationFailures: 0,
        sync: { accounts: 0, needsReauth: 0, oldestSuccessfulSyncAt: null, stale: 0, fresh: false },
      };
    const health = await repository.health();
    return { ...health, database: true };
  });

  app.get("/api/accounts", async () => ({ accounts: await repository.listAccounts() }));

  app.get("/api/messages", async (request) =>
    repository.listMessages(MessageListQuerySchema.parse(request.query)),
  );

  app.get("/api/messages/:id", async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const message = await repository.getMessage(id);
    return message ?? reply.code(404).send({ error: "Message not found" });
  });

  app.get("/api/threads/:id", async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    return { messages: await repository.getThread(id) };
  });

  app.post("/api/messages/:id/action", async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const { action } = MessageActionSchema.parse(request.body);
    try {
      return reply.code(202).send({ mutationId: await repository.enqueueAction(id, action) });
    } catch (error) {
      if (error instanceof Error && error.message === "Message not found")
        return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.put("/api/messages/:id/tier", async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const { tier } = TierOverrideSchema.parse(request.body);
    await repository.setTierOverride(id, tier);
    return { ok: true };
  });

  app.get("/api/search", async (request) =>
    services.search(SearchQuerySchema.parse(request.query)),
  );

  app.get("/api/drafts", async () => ({ drafts: await repository.listDrafts() }));
  app.get("/api/drafts/:id", async (request, reply) => {
    const draft = await repository.getDraft(IdParamSchema.parse(request.params).id);
    return draft ?? reply.code(404).send({ error: "Draft not found" });
  });
  app.post("/api/drafts", async (request) =>
    repository.createOrUpdateDraft(DraftInputSchema.parse(request.body)),
  );
  app.put("/api/drafts/:id", async (request) => {
    const id = IdParamSchema.parse(request.params).id;
    return repository.createOrUpdateDraft({ ...DraftInputSchema.parse(request.body), id });
  });
  app.delete("/api/drafts/:id", async (request) => {
    await repository.deleteDraft(IdParamSchema.parse(request.params).id);
    return { ok: true };
  });
  app.post("/api/drafts/:id/send", async (request, reply) => {
    const id = IdParamSchema.parse(request.params).id;
    const draft = await repository.getDraft(id);
    if (!draft) return reply.code(404).send({ error: "Draft not found" });
    const account = await repository.getStoredAccount(draft.accountId);
    if (!account) return reply.code(404).send({ error: "Account not found" });
    const attachments: Array<{ filename: string; contentType: string; contentBase64: string }> = [];
    let attachmentBytes = 0;
    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const bytes = await part.toBuffer();
        attachmentBytes += bytes.length;
        if (attachmentBytes > MAX_ATTACHMENT_BYTES)
          return reply.code(413).send({ error: "Attachments exceed the 20 MB Sent limit" });
        attachments.push({
          filename: part.filename,
          contentType: part.mimetype,
          contentBase64: bytes.toString("base64"),
        });
      }
    }
    return reply.code(202).send({ mutationId: await repository.enqueueSend(id, attachments) });
  });

  app.get("/api/messages/:id/attachments/:attachmentId", async (request, reply) => {
    const params = z
      .object({ id: z.string().uuid(), attachmentId: z.string().min(1) })
      .parse(request.params);
    const message = await repository.getMessage(params.id);
    if (!message) return reply.code(404).send({ error: "Message not found" });
    const account = await repository.getStoredAccount(message.account.id);
    if (!account) return reply.code(404).send({ error: "Account not found" });
    const attachment = await services
      .provider(account.provider)
      .fetchAttachment(
        account,
        (await repository.getProviderMessageReference(message.id))?.providerMessageId ?? "",
        params.attachmentId,
      );
    return reply
      .header("Content-Type", attachment.contentType)
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      )
      .send(attachment.bytes);
  });

  app.get("/api/oauth/:provider/start", async (request) => {
    const { provider } = z.object({ provider: ProviderSchema }).parse(request.params);
    const state = await createOAuthState(provider, sessionSecret);
    return { url: await services.provider(provider).getAuthorizationUrl(state) };
  });

  app.get("/api/oauth/:provider/callback", async (request, reply) => {
    const params = z.object({ provider: ProviderSchema }).parse(request.params);
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .parse(request.query);
    const stateProvider = await verifyOAuthState(query.state, sessionSecret);
    if (stateProvider !== params.provider) throw new Error("OAuth provider did not match state");
    const connected = await services
      .provider(params.provider)
      .exchangeAuthorizationCode(query.code);
    await repository.upsertAccount({
      provider: params.provider,
      email: connected.email,
      displayName: connected.displayName,
      encryptedCredentials: connected.credentials,
    });
    return reply.redirect(new URL("/settings?connected=1", webUrl).toString());
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof app.multipartErrors.RequestFileTooLargeError)
      return reply.code(413).send({ error: "Attachments exceed the 20 MB Sent limit" });
    if (
      error instanceof app.multipartErrors.FilesLimitError ||
      error instanceof app.multipartErrors.PartsLimitError
    )
      return reply.code(413).send({ error: `Attach at most ${MAX_ATTACHMENT_COUNT} files` });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: "Invalid request", details: error.issues });
    const safeError = error instanceof Error ? error : new Error(String(error));
    app.log.error({ err: { name: safeError.name, message: safeError.message } }, "request failed");
    return reply.code(500).send({ error: "Something went wrong" });
  });

  if (options.serveWeb !== false) {
    const webRoot = resolve(process.cwd(), env().WEB_DIST_PATH);
    try {
      await access(webRoot);
      await app.register(fastifyStatic, { root: webRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
        return reply.sendFile("index.html");
      });
    } catch {
      app.log.info("Web build not found; API-only mode enabled");
    }
  }

  return app;
}
