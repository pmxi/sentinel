import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query";
import { Command, Menu, X } from "lucide-solid";
import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  untrack,
  useContext,
} from "solid-js";
import { ApiError, sentApi } from "./api";
import { CommandProvider, useCommandPalette, useCommands } from "./commands";
import { ComposeProvider, useCompose } from "./compose";
import { InboxPage, SearchResults } from "./InboxPage";
import { LoginPage } from "./LoginPage";
import { LiveUpdates } from "./live";
import { quietUntil } from "./mail-cache";
import { createMailboxReplica, replicaFor } from "./replica";
import { waitForReplicaWipe } from "./replica-session";
import { Link, NavLink, useLocation, useNavigate } from "./router";
import type { Account, Draft } from "./shared";
import {
  forgetShellMetadata,
  readShellMetadata,
  rememberAccounts,
  rememberSession,
  SHELL_METADATA_KEY,
  UNAUTHORIZED_EVENT,
} from "./shell-metadata";
import { TriageProvider } from "./triage";

const AccountsContext = createContext<Accessor<Account[]>>(() => []);
export function clearAuthenticatedSession(client: ReturnType<typeof useQueryClient>) {
  if (client.isMutating({ mutationKey: ["logout"] })) return;
  forgetShellMetadata();
  client.setQueryData(["session"], { authenticated: false });
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
}
export function InboxRoute() {
  const accounts = useContext(AccountsContext);
  return <InboxPage accounts={accounts()} />;
}
export function SearchRoute() {
  const accounts = useContext(AccountsContext);
  return <SearchResults accounts={accounts()} />;
}
export function SettingsRoute() {
  const accounts = useContext(AccountsContext);
  return <SettingsPage accounts={accounts()} />;
}
export default function App(props: { children?: JSX.Element }) {
  const client = useQueryClient();
  const metadata = readShellMetadata();
  const session = createQuery(() => ({
    queryKey: ["session"],
    queryFn: sentApi.session,
    retry: false,
    initialData: metadata ? { authenticated: true } : undefined,
    initialDataUpdatedAt: 0,
    networkMode: "always",
  }));
  createEffect(() => {
    if (session.isFetched && session.isSuccess && session.data.authenticated) rememberSession();
  });
  onMount(() => {
    const unauthorized = () => {
      clearAuthenticatedSession(client);
    };
    const storage = (event: StorageEvent) => {
      if ((event.key === SHELL_METADATA_KEY || event.key === null) && !readShellMetadata())
        unauthorized();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    window.addEventListener("storage", storage);
    onCleanup(() => {
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
      window.removeEventListener("storage", storage);
    });
  });
  return (
    <>
      {(() => {
        if (session.isLoading)
          return (
            <div class="app-loading">
              <strong>Sent</strong>
            </div>
          );
        if (
          session.data?.authenticated === false ||
          (session.error instanceof ApiError && session.error.status === 401)
        )
          return <LoginPage />;
        if (session.isError && !session.data)
          return (
            <div class="fatal-error">
              <strong>Sent couldn’t start.</strong>
              <span>{session.error.message}</span>
            </div>
          );
        return <AuthenticatedApp>{props.children}</AuthenticatedApp>;
      })()}
    </>
  );
}
function AuthenticatedApp(props: { children?: JSX.Element }) {
  const client = useQueryClient();
  const replica = createMailboxReplica(
    client,
    () => quietUntil(client) <= Date.now(),
    () => client.getQueryState(["session"])?.status === "success",
  );
  const live = new LiveUpdates(client, {
    verified: () => client.getQueryState(["session"])?.status === "success",
    cursor: () => replicaFor(client)?.syncCursor(),
    wake: () => replicaFor(client)?.wake(),
    canApply: () => quietUntil(client) <= Date.now(),
    changed: async (frame) => {
      const current = replicaFor(client);
      if (current?.ready()) {
        await current.receiveLive(frame);
        void client.invalidateQueries({ queryKey: ["drafts"] });
      } else {
        void current?.receiveLive(frame);
        await client.invalidateQueries(
          {
            predicate: (query) =>
              ["messages", "message", "thread", "accounts", "drafts", "search"].includes(
                String(query.queryKey[0]),
              ),
          },
          { cancelRefetch: false },
        );
      }
    },
  });
  createEffect(() => {
    if (replica?.ready()) live.subscribe();
  });
  createEffect(() => {
    document.documentElement.dataset.sentLive = live.healthy() ? "ready" : "polling";
  });
  createEffect(() => {
    if (!replica) return;
    document.documentElement.dataset.sentReplica = replica.status().ready ? "ready" : "loading";
    document.documentElement.dataset.sentReplicaStorage = replica.status().persistent
      ? "opfs"
      : "memory";
    document.documentElement.dataset.sentReplicaSession = replica.id;
    document.documentElement.dataset.sentReplicaBodies = replica.status().bodiesReady
      ? "ready"
      : "syncing";
  });
  onCleanup(() => {
    live.close();
    delete document.documentElement.dataset.sentLive;
    void replica?.close();
    if (replica && document.documentElement.dataset.sentReplicaSession === replica.id) {
      delete document.documentElement.dataset.sentReplica;
      delete document.documentElement.dataset.sentReplicaStorage;
      delete document.documentElement.dataset.sentReplicaSession;
      delete document.documentElement.dataset.sentReplicaBodies;
    }
  });
  const metadata = readShellMetadata();
  const accounts = createQuery(() => ({
    queryKey: ["accounts"],
    queryFn: sentApi.accounts,
    initialData: metadata ? { accounts: metadata.accounts } : undefined,
    initialDataUpdatedAt: 0,
  }));
  createEffect(() => {
    if (accounts.isFetched && accounts.isSuccess) rememberAccounts(accounts.data.accounts);
  });
  return (
    <>
      {
        <AccountsContext.Provider value={() => accounts.data?.accounts ?? []}>
          <TriageProvider>
            <ComposeProvider accounts={accounts.data?.accounts ?? []}>
              <CommandProvider>
                <Shell accounts={accounts.data?.accounts ?? []}>{props.children}</Shell>
              </CommandProvider>
            </ComposeProvider>
          </TriageProvider>
        </AccountsContext.Provider>
      }
    </>
  );
}
function Shell(props: { accounts: Account[]; children?: JSX.Element }) {
  const [online, setOnline] = createSignal(navigator.onLine);
  onMount(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    onCleanup(() => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    });
  });
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const location = useLocation();
  const navigate = useNavigate();
  const compose = useCompose();
  createEffect(() => {
    if (location.pathname === "/search")
      setQuery(new URLSearchParams(location.search).get("q") ?? "");
  });
  const searchInput = { current: null } as {
    current: HTMLInputElement | null;
  };
  const { openPalette } = useCommandPalette();
  useCommands("shell", () => [
    {
      id: "compose",
      label: "Compose a message",
      group: "Mail",
      keys: ["c"],
      run: () => {
        setMenuOpen(false);
        compose.openCompose();
      },
    },
    {
      id: "search",
      label: "Search mail",
      group: "Mail",
      keys: ["/"],
      run: () => {
        setMenuOpen(false);
        searchInput.current?.focus();
      },
    },
    ...(
      [
        ["important", "Go to Important inbox", "g i", "/inbox/l1"],
        ["updates", "Go to Updates", "g u", "/inbox/l2"],
        ["low", "Go to Low priority", "g l", "/inbox/l3"],
        ["all", "Go to All mail", "g a", "/inbox/all"],
        ["sent", "Go to Sent", "g s", "/inbox/sent"],
        ["drafts", "Go to Drafts", "g d", "/drafts"],
        ["trash", "Go to Trash", "g t", "/inbox/trash"],
      ] as const
    ).map(([id, label, key, path]) => ({
      id,
      label,
      group: "Navigation" as const,
      keys: [key],
      run: () => navigate(path),
    })),
  ]);
  createEffect(() => {
    [location.pathname];
    const cleanup = untrack(() => {
      if (location.pathname) setMenuOpen(false);
    });
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  const submitSearch = (event: SubmitEvent) => {
    event.preventDefault();
    if (query().trim()) navigate(`/search?q=${encodeURIComponent(query().trim())}`);
  };
  return (
    <>
      {
        <div class="app-shell">
          <aside class={`sidebar ${menuOpen() ? "open" : ""}`}>
            <div class="sidebar-brand">
              <Link href="/">
                <strong>Sent</strong>
              </Link>
              <button class="mobile-close" onClick={() => setMenuOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <button
              class="compose-button"
              onClick={() => {
                compose.openCompose();
                setMenuOpen(false);
              }}
            >
              Compose
            </button>
            <nav>
              <span class="nav-label">Attention</span>
              <NavItem href="/inbox/l1" label="Important" badge="L1" />
              <NavItem href="/inbox/l2" label="Updates" badge="L2" />
              <NavItem href="/inbox/l3" label="Low priority" badge="L3" />
              <span class="nav-label secondary">Mail</span>
              <NavItem href="/inbox/unclassified" label="Sorting" />
              <NavItem href="/inbox/all" label="All mail" />
              <NavItem href="/inbox/sent" label="Sent" />
              <NavItem href="/drafts" label="Drafts" />
              <NavItem href="/inbox/trash" label="Trash" />
            </nav>
            <div class="sidebar-bottom">
              <button
                class="shortcuts-button"
                onClick={openPalette}
                disabled={compose.isOpen}
                title="Commands: ⌘K / Ctrl+K. Press ? to browse shortcuts."
                aria-keyshortcuts="Meta+k Control+k"
              >
                <Command size={15} />
                <span>Commands</span>
                <kbd>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
              </button>
              <NavItem href="/settings" label="Settings" />
              <div class="account-stack">
                {props.accounts.map((account) => (
                  <div title={account.email}>
                    <span>{account.email}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
          {menuOpen() && (
            <button
              class="sidebar-scrim"
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
            />
          )}
          <main class="app-main">
            <header class="topbar">
              <button class="mobile-menu" onClick={() => setMenuOpen(true)}>
                <Menu size={21} />
              </button>
              <form class="global-search" onSubmit={submitSearch}>
                <input
                  ref={(element) => {
                    searchInput.current = element;
                  }}
                  aria-label="Search mail"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.currentTarget.blur();
                  }}
                />
                <kbd>/</kbd>
              </form>
            </header>
            {!online() && (
              <div class="connect-banner" role="status">
                Offline. Reconnect to load mail.
              </div>
            )}
            {online() && props.accounts.length === 0 && location.pathname !== "/settings" && (
              <div class="connect-banner">
                <span>Connect an account to import mail.</span>
                <Link href="/settings">Open settings →</Link>
              </div>
            )}
            {props.children}
          </main>
        </div>
      }
    </>
  );
}
function NavItem(props: { href: string; label: string; badge?: string }) {
  return (
    <>
      {
        <NavLink href={props.href}>
          <span>{props.label}</span>
          {props.badge && <small>{props.badge}</small>}
        </NavLink>
      }
    </>
  );
}
export function DraftsPage() {
  const compose = useCompose();
  const drafts = createQuery(() => ({ queryKey: ["drafts"], queryFn: sentApi.drafts }));
  return (
    <>
      {
        <section class="single-page">
          <header class="page-title">
            <h1>Drafts</h1>
          </header>
          <div class="draft-list">
            {drafts.data?.drafts.map((draft: Draft) => (
              <button onClick={() => compose.openCompose(draft)}>
                <span>
                  <strong>{draft.subject || "Untitled message"}</strong>
                  <small>
                    {draft.to.length
                      ? `To ${draft.to.map((item) => item.name || item.address).join(", ")}`
                      : "No recipients"}
                  </small>
                  <p>{draft.body || "Empty draft"}</p>
                </span>
                <time>
                  {new Date(draft.updatedAt).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </button>
            ))}
          </div>
          {!drafts.isLoading && !drafts.data?.drafts.length && (
            <div class="empty-list">
              <strong>No drafts</strong>
            </div>
          )}
        </section>
      }
    </>
  );
}
function SettingsPage(props: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connect = async (provider: "gmail" | "microsoft") => {
    const { url } = await sentApi.oauthUrl(provider);
    window.location.assign(url);
  };
  const logout = createMutation(() => ({
    mutationKey: ["logout"],
    mutationFn: sentApi.logout,
    onSuccess: async () => {
      await waitForReplicaWipe(forgetShellMetadata());
      queryClient.clear();
      navigate("/");
      window.location.reload();
    },
  }));
  return (
    <>
      {
        <section class="single-page settings-page">
          <header class="page-title">
            <h1>Settings</h1>
          </header>
          <div class="settings-section">
            <h2>Accounts</h2>
            <div class="settings-card">
              {props.accounts.map((account) => (
                <div class="connected-account">
                  <span>{account.email}</span>
                  <span>{account.status.replace("_", " ")}</span>
                </div>
              ))}
              <div class="connect-actions">
                <button onClick={() => void connect("gmail")}>Connect Gmail</button>
                <button onClick={() => void connect("microsoft")}>Connect Microsoft</button>
              </div>
            </div>
          </div>
          <div class="settings-section">
            <h2>Session</h2>
            <button class="logout-button" onClick={() => logout.mutate()}>
              Sign out
            </button>
          </div>
        </section>
      }
    </>
  );
}
