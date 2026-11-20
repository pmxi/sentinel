import type { Account } from "@sent/shared";
import { endReplicaSession } from "./replica-session";
import { clearShellReloadGuards } from "./service-worker";

export const SHELL_METADATA_KEY = "sent:shell:v1";
export const UNAUTHORIZED_EVENT = "sent:unauthorized";
type Metadata = { version: 1; accounts: Account[] };

function isAccount(value: unknown): value is Account {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.id === "string" &&
    typeof account.email === "string" &&
    typeof account.displayName === "string" &&
    ["gmail", "microsoft"].includes(String(account.provider)) &&
    ["active", "needs_reauth", "syncing", "error"].includes(String(account.status)) &&
    (account.lastSyncedAt === null || typeof account.lastSyncedAt === "string")
  );
}

export function readShellMetadata(): Metadata | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(SHELL_METADATA_KEY) ?? "null");
    if (value?.version === 1 && Array.isArray(value.accounts) && value.accounts.every(isAccount))
      return value;
  } catch {}
}

function write(accounts: Account[]) {
  try {
    localStorage.setItem(
      SHELL_METADATA_KEY,
      JSON.stringify({
        version: 1,
        accounts: accounts.map(({ id, provider, email, displayName, status, lastSyncedAt }) => ({
          id,
          provider,
          email,
          displayName,
          status,
          lastSyncedAt,
        })),
      }),
    );
  } catch {}
}

export function rememberSession() {
  write(readShellMetadata()?.accounts ?? []);
}
export function rememberAccounts(accounts: Account[]) {
  if (readShellMetadata()) write(accounts);
}
export function forgetShellMetadata() {
  try {
    localStorage.removeItem(SHELL_METADATA_KEY);
  } catch {}
  clearShellReloadGuards();
  endReplicaSession();
}
