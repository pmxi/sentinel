import type { Draft, SearchResponse } from "@sent/shared";
import { createIntelligenceService, type IntelligenceService } from "./ai.ts";
import { MailRepository } from "./db/repository.ts";
import { createProviders } from "./providers/index.ts";
import { contentHash, messageAnalysisText } from "./providers/normalize.ts";
import type { MailProvider, OutgoingAttachment } from "./providers/types.ts";

export class SentServices {
  readonly providers: ReturnType<typeof createProviders>;

  constructor(
    readonly repository = new MailRepository(),
    readonly intelligence: IntelligenceService = createIntelligenceService(),
  ) {
    this.providers = createProviders((accountId, encrypted) =>
      this.repository.updateCredentials(accountId, encrypted),
    );
  }

  provider(name: "gmail" | "microsoft"): MailProvider {
    return this.providers[name];
  }

  async syncAccount(accountId: string): Promise<string[]> {
    const account = await this.repository.getStoredAccount(accountId);
    if (!account) throw new Error("Account not found");
    const cursor = await this.repository.getSyncCursor(accountId);
    try {
      const page = await this.provider(account.provider).sync(account, cursor.cursor);
      const changed: string[] = [];
      await this.repository.tombstoneMessages(accountId, page.deletedProviderMessageIds);
      for (const message of page.messages) {
        const saved = await this.repository.upsertMessage(accountId, message);
        if (saved.changed) changed.push(saved.id);
      }
      await this.repository.finishSync(accountId, page.nextCursor, page.backfillComplete);
      return changed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsReauth = /invalid_grant|interaction_required|unauthorized|401/i.test(message);
      await this.repository.failSync(accountId, message, needsReauth);
      throw error;
    }
  }

  async classifyMessage(messageId: string): Promise<void> {
    const message = await this.repository.getAnalysisMessage(messageId);
    if (!message) return;
    try {
      const result = await this.intelligence.classify(messageAnalysisText(message));
      await this.repository.saveClassification(messageId, result);
    } catch (error) {
      await this.repository.saveClassificationFailure(
        messageId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async embedMessage(messageId: string): Promise<void> {
    const message = await this.repository.getAnalysisMessage(messageId);
    if (!message) return;
    const text = messageAnalysisText(message);
    const result = await this.intelligence.embed(text);
    await this.repository.saveEmbedding(
      messageId,
      result.embedding,
      result.model,
      contentHash(text),
    );
  }

  async search(input: {
    q: string;
    accountId?: string;
    tier?: 1 | 2 | 3;
    after?: Date;
    before?: Date;
    hasAttachment?: boolean;
    limit: number;
  }): Promise<SearchResponse> {
    try {
      const { embedding } = await this.intelligence.embed(input.q);
      return await this.repository.search({ ...input, embedding });
    } catch {
      // Search remains useful while OpenAI is unavailable; callers can surface lexical mode.
      return this.repository.search(input);
    }
  }

  async processOutbox(): Promise<number> {
    const items = await this.repository.claimMutations();
    for (const item of items) {
      try {
        const account = await this.repository.getStoredAccount(item.accountId);
        if (!account) throw new Error("Mutation account no longer exists");
        const provider = this.provider(account.provider);
        if (item.action === "send") {
          const payload = item.payload as { draft?: Draft; attachments?: OutgoingAttachment[] };
          if (!payload.draft) throw new Error("Send mutation is missing its draft");
          let inReplyTo: string | null = null;
          let replyToProviderMessageId: string | null = null;
          let forwardOfProviderMessageId: string | null = null;
          const references: string[] = [];
          if (payload.draft.replyToMessageId) {
            const original = await this.repository.getMessage(payload.draft.replyToMessageId);
            inReplyTo = original?.internetMessageId ?? null;
            replyToProviderMessageId =
              (await this.repository.getProviderMessageReference(payload.draft.replyToMessageId))
                ?.providerMessageId ?? null;
            if (inReplyTo) references.push(inReplyTo);
          }
          if (payload.draft.forwardOfMessageId) {
            forwardOfProviderMessageId =
              (await this.repository.getProviderMessageReference(payload.draft.forwardOfMessageId))
                ?.providerMessageId ?? null;
          }
          await provider.send(account, {
            from: account.email,
            to: payload.draft.to,
            cc: payload.draft.cc,
            bcc: payload.draft.bcc,
            subject: payload.draft.subject,
            body: payload.draft.body,
            inReplyTo,
            replyToProviderMessageId,
            forwardOfProviderMessageId,
            references,
            attachments: payload.attachments ?? [],
          });
        } else {
          if (!item.messageId) throw new Error("Message mutation is missing its message id");
          const reference = await this.repository.getProviderMessageReference(item.messageId);
          if (!reference) throw new Error("Mutation message no longer exists");
          await provider.applyAction(
            account,
            reference.providerMessageId,
            item.action as Parameters<MailProvider["applyAction"]>[2],
          );
        }
        await this.repository.completeMutation(item.id);
      } catch (error) {
        await this.repository.failMutation(
          item.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return items.length;
  }
}
