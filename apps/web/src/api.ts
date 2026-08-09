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
  thread: (id: string) => api<{ messages: MessageDetail[] }>(`/api/threads/${id}`),
  action: (id: string, action: string) =>
    api<{ mutationId: string }>(`/api/messages/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
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
    return api<{ mutationId: string }>(`/api/drafts/${id}/send`, { method: "POST", body });
  },
  oauthUrl: (provider: "gmail" | "microsoft") =>
    api<{ url: string }>(`/api/oauth/${provider}/start`),
};
