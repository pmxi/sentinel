import { GmailProvider } from "./gmail.ts";
import { MicrosoftProvider } from "./microsoft.ts";

export type CredentialPersister = (accountId: string, encrypted: string) => Promise<void>;

export function createProviders(persistCredentials: CredentialPersister) {
  return {
    gmail: new GmailProvider(persistCredentials),
    microsoft: new MicrosoftProvider(persistCredentials),
  };
}

export * from "./types.ts";
