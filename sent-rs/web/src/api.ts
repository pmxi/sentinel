import type {
  Account,
  Draft,
  DraftInput,
  MessageDetail,
  MessageListResponse,
  SearchResponse,
  Tier,
} from "@sent/shared";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && !["GET", "HEAD"].includes(init.method)) headers.set("x-sent-request", "1");
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new ApiError(payload.error ?? response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const sentApi = {
  session: () => api<{ authenticated: boolean }>("/api/auth/session"),
  login: (password: string) =>
    api<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  accounts: () => api<{ accounts: Account[] }>("/api/accounts"),
  messages: (query: URLSearchParams) => api<MessageListResponse>(`/api/messages?${query}`),
  message: (id: string) => api<MessageDetail>(`/api/messages/${id}`),
  thread: (id: string, trash = false) =>
    api<{ messages: MessageDetail[] }>(`/api/threads/${id}?trash=${trash}`),
  action: (id: string, action: string, undoable = false) =>
    api<import("@sent/shared").MutationReceipt>(`/api/messages/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, undoable }),
    }),
  threadAction: (id: string, action: "archive" | "delete", view: string, accountId?: string) =>
    api<import("@sent/shared").MutationReceipt>(`/api/threads/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, view, accountId, undoable: true }),
    }),
  undo: (id: string) =>
    api<{ draft: Draft | null }>(`/api/mutations/${id}/undo`, { method: "POST" }),
  tier: (id: string, tier: Tier | null) =>
    api<{ ok: true }>(`/api/messages/${id}/tier`, {
      method: "PUT",
      body: JSON.stringify({ tier }),
    }),
  search: (query: URLSearchParams) => api<SearchResponse>(`/api/search?${query}`),
  drafts: () => api<{ drafts: Draft[] }>("/api/drafts"),
  saveDraft: (draft: DraftInput) =>
    api<Draft>(draft.id ? `/api/drafts/${draft.id}` : "/api/drafts", {
      method: draft.id ? "PUT" : "POST",
      body: JSON.stringify(draft),
    }),
  deleteDraft: (id: string) => api<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),
  sendDraft: (id: string, files: File[]) => {
    const body = new FormData();
    for (const file of files) body.append("attachment", file);
    return api<import("@sent/shared").MutationReceipt>(`/api/drafts/${id}/send?undoable=true`, {
      method: "POST",
      body,
    });
  },
  oauthUrl: (provider: "gmail" | "microsoft") =>
    api<{ url: string }>(`/api/oauth/${provider}/start`),
};
