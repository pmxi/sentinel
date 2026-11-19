import type { Account, Draft } from "@sent/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Command, Menu, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ApiError, sentApi } from "./api";
import { CommandProvider, useCommandPalette, useCommands } from "./commands";
import { ComposeProvider, useCompose } from "./compose";
import { InboxPage, SearchResults } from "./InboxPage";
import { LoginPage } from "./LoginPage";

export default function App() {
  const session = useQuery({ queryKey: ["session"], queryFn: sentApi.session, retry: false });
  if (session.isLoading)
    return (
      <div className="app-loading">
        <strong>Sent</strong>
      </div>
    );
  if (session.error instanceof ApiError && session.error.status === 401) return <LoginPage />;
  if (session.isError)
    return (
      <div className="fatal-error">
        <strong>Sent couldn’t start.</strong>
        <span>{session.error.message}</span>
      </div>
    );
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: sentApi.accounts });
  return (
    <ComposeProvider accounts={accounts.data?.accounts ?? []}>
      <CommandProvider>
        <Routes>
          <Route element={<Shell accounts={accounts.data?.accounts ?? []} />}>
            <Route index element={<Navigate to="/inbox/l1" replace />} />
            <Route
              path="/inbox/:view"
              element={<InboxPage accounts={accounts.data?.accounts ?? []} />}
            />
            <Route
              path="/search"
              element={<SearchResults accounts={accounts.data?.accounts ?? []} />}
            />
            <Route path="/drafts" element={<DraftsPage />} />
            <Route
              path="/settings"
              element={<SettingsPage accounts={accounts.data?.accounts ?? []} />}
            />
            <Route path="*" element={<Navigate to="/inbox/l1" replace />} />
          </Route>
        </Routes>
      </CommandProvider>
    </ComposeProvider>
  );
}

function Shell({ accounts }: { accounts: Account[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const compose = useCompose();
  const searchInput = useRef<HTMLInputElement>(null);
  const { openPalette } = useCommandPalette();
  useCommands("shell", [
    {
      id: "compose",
      label: "Compose a message",
      group: "Mail",
      keys: ["c"],
      run: () => compose.openCompose(),
    },
    {
      id: "search",
      label: "Search mail",
      group: "Mail",
      keys: ["/"],
      run: () => searchInput.current?.focus(),
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
  useEffect(() => {
    if (location.pathname) setMenuOpen(false);
  }, [location.pathname]);
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Link to="/">
            <strong>Sent</strong>
          </Link>
          <button className="mobile-close" onClick={() => setMenuOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <button
          className="compose-button"
          onClick={() => {
            compose.openCompose();
            setMenuOpen(false);
          }}
        >
          Compose
        </button>
        <nav>
          <span className="nav-label">Attention</span>
          <NavItem to="/inbox/l1" label="Important" badge="L1" />
          <NavItem to="/inbox/l2" label="Updates" badge="L2" />
          <NavItem to="/inbox/l3" label="Low priority" badge="L3" />
          <span className="nav-label secondary">Mail</span>
          <NavItem to="/inbox/unclassified" label="Sorting" />
          <NavItem to="/inbox/all" label="All mail" />
          <NavItem to="/inbox/sent" label="Sent" />
          <NavItem to="/drafts" label="Drafts" />
          <NavItem to="/inbox/trash" label="Trash" />
        </nav>
        <div className="sidebar-bottom">
          <button
            className="shortcuts-button"
            onClick={openPalette}
            disabled={compose.isOpen}
            title="Commands: ⌘K / Ctrl+K. Press ? to browse shortcuts."
            aria-keyshortcuts="Meta+k Control+k"
          >
            <Command size={15} />
            <span>Commands</span>
            <kbd>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
          </button>
          <NavItem to="/settings" label="Settings" />
          <div className="account-stack">
            {accounts.map((account) => (
              <div key={account.id} title={account.email}>
                <span>{account.email}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
      {menuOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
        />
      )}
      <main className="app-main">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}>
            <Menu size={21} />
          </button>
          <form className="global-search" onSubmit={submitSearch}>
            <input
              ref={searchInput}
              aria-label="Search mail"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
              }}
            />
            <kbd>/</kbd>
          </form>
        </header>
        {accounts.length === 0 && location.pathname !== "/settings" && (
          <div className="connect-banner">
            <span>Connect an account to import mail.</span>
            <Link to="/settings">Open settings →</Link>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({ to, label, badge }: { to: string; label: string; badge?: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
      <span>{label}</span>
      {badge && <small>{badge}</small>}
    </NavLink>
  );
}

function DraftsPage() {
  const compose = useCompose();
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: sentApi.drafts });
  return (
    <section className="single-page">
      <header className="page-title">
        <h1>Drafts</h1>
      </header>
      <div className="draft-list">
        {drafts.data?.drafts.map((draft: Draft) => (
          <button key={draft.id} onClick={() => compose.openCompose(draft)}>
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
        <div className="empty-list">
          <strong>No drafts</strong>
        </div>
      )}
    </section>
  );
}

function SettingsPage({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const connect = async (provider: "gmail" | "microsoft") => {
    const { url } = await sentApi.oauthUrl(provider);
    window.location.assign(url);
  };
  const logout = useMutation({
    mutationFn: sentApi.logout,
    onSuccess: () => {
      queryClient.clear();
      navigate("/");
      window.location.reload();
    },
  });
  return (
    <section className="single-page settings-page">
      <header className="page-title">
        <h1>Settings</h1>
      </header>
      <div className="settings-section">
        <h2>Accounts</h2>
        <div className="settings-card">
          {accounts.map((account) => (
            <div className="connected-account" key={account.id}>
              <span>{account.email}</span>
              <span>{account.status.replace("_", " ")}</span>
            </div>
          ))}
          <div className="connect-actions">
            <button onClick={() => void connect("gmail")}>Connect Gmail</button>
            <button onClick={() => void connect("microsoft")}>Connect Microsoft</button>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <h2>Session</h2>
        <button className="logout-button" onClick={() => logout.mutate()}>
          Sign out
        </button>
      </div>
    </section>
  );
}
