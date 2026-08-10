import type { Account, Draft } from "@sent/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  Inbox,
  LogOut,
  Mail,
  Menu,
  PenLine,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
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
import { ComposeProvider, useCompose } from "./compose";
import { InboxPage, SearchResults } from "./InboxPage";
import { LoginPage } from "./LoginPage";

export default function App() {
  const session = useQuery({ queryKey: ["session"], queryFn: sentApi.session, retry: false });
  if (session.isLoading)
    return (
      <div className="app-loading">
        <span className="brand-mark">S</span>
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
    </ComposeProvider>
  );
}

function Shell({ accounts }: { accounts: Account[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const compose = useCompose();
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
            <span className="brand-mark">S</span>
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
          <PenLine size={17} /> Compose
        </button>
        <nav>
          <span className="nav-label">Attention</span>
          <NavItem to="/inbox/l1" icon={<Sparkles size={17} />} label="Important" badge="L1" />
          <NavItem to="/inbox/l2" icon={<Inbox size={17} />} label="Updates" badge="L2" />
          <NavItem to="/inbox/l3" icon={<Archive size={17} />} label="Low priority" badge="L3" />
          <span className="nav-label secondary">Mail</span>
          <NavItem to="/inbox/unclassified" icon={<CircleDashed size={17} />} label="Sorting" />
          <NavItem to="/inbox/all" icon={<Mail size={17} />} label="All mail" />
          <NavItem to="/inbox/sent" icon={<Send size={17} />} label="Sent" />
          <NavItem to="/drafts" icon={<PenLine size={17} />} label="Drafts" />
          <NavItem to="/inbox/trash" icon={<Trash2 size={17} />} label="Trash" />
        </nav>
        <div className="sidebar-bottom">
          <NavItem to="/settings" icon={<Settings size={17} />} label="Settings" />
          <div className="account-stack">
            {accounts.map((account) => (
              <div key={account.id} title={account.email}>
                <span className={`account-dot ${account.provider}`} />
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
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by person, topic, or meaning…"
            />
            <kbd>⌘ K</kbd>
          </form>
          <Link to="/settings" className="topbar-avatar">
            PM
          </Link>
        </header>
        {accounts.length === 0 && location.pathname !== "/settings" && (
          <div className="connect-banner">
            <span>
              <strong>Connect your first inbox</strong> to begin importing mail.
            </span>
            <Link to="/settings">
              Open settings <ChevronRight size={15} />
            </Link>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  badge,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
}) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
      {icon}
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
        <span className="eyebrow">Mail</span>
        <h1>Drafts</h1>
        <p>Saved inside Sent and available on every device.</p>
      </header>
      <div className="draft-list">
        {drafts.data?.drafts.map((draft: Draft) => (
          <button key={draft.id} onClick={() => compose.openCompose(draft)}>
            <span className="draft-icon">
              <PenLine size={17} />
            </span>
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
          <span>Messages you’re writing will be saved here.</span>
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
        <span className="eyebrow">Sent</span>
        <h1>Settings</h1>
        <p>Connect the inboxes that should feel like one.</p>
      </header>
      <div className="settings-section">
        <div>
          <h2>Mail accounts</h2>
          <p>
            Sent keeps a private synchronized copy. Gmail and Microsoft remain the source of truth.
          </p>
        </div>
        <div className="settings-card">
          {accounts.map((account) => (
            <div className="connected-account" key={account.id}>
              <span className={`provider-logo ${account.provider}`}>
                {account.provider === "gmail" ? "G" : "M"}
              </span>
              <span>
                <strong>{account.displayName || account.email}</strong>
                <small>{account.email}</small>
              </span>
              <span className={`status-pill ${account.status}`}>
                {account.status.replace("_", " ")}
              </span>
            </div>
          ))}
          <div className="connect-actions">
            <button onClick={() => void connect("gmail")}>
              <span className="provider-logo gmail">G</span>Connect Gmail
            </button>
            <button onClick={() => void connect("microsoft")}>
              <span className="provider-logo microsoft">M</span>Connect Microsoft
            </button>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <div>
          <h2>Intelligence</h2>
          <p>
            Classification follows the versioned policy in <code>prompts/classify-v1.md</code>.
          </p>
        </div>
        <div className="settings-card compact">
          <div className="setting-row">
            <Sparkles size={18} />
            <span>
              <strong>L1 / L2 / L3 sorting</strong>
              <small>Every new message is classified by OpenAI.</small>
            </span>
            <span className="status-pill active">Configured on server</span>
          </div>
          <div className="setting-row">
            <Search size={18} />
            <span>
              <strong>Hybrid search</strong>
              <small>Postgres full text plus semantic embeddings.</small>
            </span>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <div>
          <h2>Session</h2>
          <p>This deployment has one owner and no recovery flow.</p>
        </div>
        <div className="settings-card compact">
          <button className="logout-button" onClick={() => logout.mutate()}>
            <LogOut size={17} /> Sign out
          </button>
        </div>
      </div>
      <footer className="settings-footer">
        <CircleHelp size={16} /> Sent is private, single-user software.
      </footer>
    </section>
  );
}
