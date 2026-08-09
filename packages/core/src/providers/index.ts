import type { Provider } from "@sent/shared";
import { GmailProvider } from "./gmail.ts";
import { MicrosoftProvider } from "./microsoft.ts";
import type { MailProvider } from "./types.ts";

export type CredentialPersister = (accountId: string, encrypted: string) => Promise<void>;

export function createProviders(
  persistCredentials: CredentialPersister,
): Record<Provider, MailProvider> {
  return {
    gmail: new GmailProvider(persistCredentials),
    microsoft: new MicrosoftProvider(persistCredentials),
  };
}

export * from "./types.ts";
