# Sentinel — development roadmap

Sentinel is becoming a **multi-tenant hosted SaaS**: users sign up with Google,
connect their Gmail via OAuth, and Sentinel monitors their inbox and alerts
them (out-of-band) when something important arrives.

The current code is a clean **single-tenant email engine** (`EmailStream` →
`OpenAIItemClassifier` → notify, driven by the supervisor in `monitor.py`).
The MVP wraps that engine in a tenancy + auth shell.

## Architecture (target)

```
Google OIDC →  WEB (Flask): login/session, dashboard, /alerts,
               "Connect Gmail" OAuth flow, per-user notes/settings
                     │  shared Postgres (everything scoped by user_id)
Gmail API   ←  WORKER (asyncio supervisor): polls every connected
 (readonly)    mailbox, classifies (operator's OpenAI key), writes
               user-scoped events + fires out-of-band notifications
```

The engine is reused largely as-is; it just becomes user-scoped. Web and worker
are separate processes sharing one DB.

## Locked design decisions

1. **Login ≠ Gmail access; incremental auth.** Sign in with Google using basic
   OIDC scopes (`openid email profile`) — frictionless, no verification. A
   separate "Connect Gmail" step requests the sensitive scope only on opt-in.
2. **`gmail.readonly`, no "mark as read."** We track processed state in our own
   `event` table; we never mutate a user's inbox. Cleaner trust + verification.
3. **Notifications are out-of-band — never email** (alerting about email via
   email is circular). MVP: in-app `/alerts` view (baseline) + Telegram opt-in
   (push). Web/mobile push is a fast-follow. The Resend email channel is removed.
4. **Operator config via env, no interactive CLI.** OpenAI key, Google client
   id/secret, `DATABASE_URL`, session secret, token-encryption key are all env.
   Launch via `sentinel-web` / `sentinel-worker`.
5. **Web/worker are separate processes from day one** (two entry points, one DB).
6. **Classification is ON** (`_CLASSIFICATION_DISABLED` in `monitor.py` must be
   `False` for the product).

## Roadmap

- [ ] **Phase 0 — Foundations**
  - [x] Roadmap doc (this file)
  - [x] Kill the interactive CLI; add `sentinel-web` / `sentinel-worker` entry
        points; operator config from env
  - [x] Remove the dead Resend email-notification channel
  - [x] Rename `Local*` → tenant-neutral (`Database`, `Monitor`, `Settings`, …)
  - [ ] Register Google Cloud project + OAuth client; **start restricted-scope
        verification** (long lead time — see external track) — *your task, non-code*
- [ ] **Phase 1 — Multi-tenant data model**: `user` table; `user_id` FK on
      `stream`/`event`/`classification`; dedup `UNIQUE(item_id)` →
      `UNIQUE(user_id, item_id)`; per-user preferences/notes; encrypted Gmail
      token storage; thread `user_id` through the DB layer + engine.
- [ ] **Phase 2 — Google Sign-In** (Authlib): OIDC login, sessions, `user`
      upsert on first login, login-gated web, logout.
- [ ] **Phase 3 — "Connect Gmail"**: per-user incremental OAuth (`readonly`),
      encrypted refresh-token storage, refresh handling, disconnect; a connected
      account becomes a per-user `stream` row.
- [ ] **Phase 4 — Tenant-aware worker**: poll all connected mailboxes, classify
      with the operator key, write user-scoped events, fire per-user
      notifications; per-tenant failure isolation.
- [ ] **Phase 5 — Per-user web UI**: scope dashboard / `/alerts` / notes /
      streams to the logged-in user; connection management; optional Telegram link.
- [ ] **Phase 6 — Hardening & launch**: token encryption verified, LLM cost
      controls, rate limits, observability, DB backups; finish Google
      verification; privacy policy + ToS.

## External track (start in Phase 0 — gates launch)

- **Google OAuth verification + CASA security assessment** for the Gmail scope.
  Capped at ~100 test users until verified; takes weeks–months and recurs.
  Often the real launch bottleneck, not the code.
- Privacy policy + ToS (required for verification).

## Risks to design for

- **LLM cost scales with users × inbox volume.** Levers: classify only
  unread / Primary-category mail, cheaper model, batching, or a cheap
  pre-filter (the removed local scorer was exactly this hedge).
- **Token security** — refresh tokens are keys to users' inboxes; encrypt at
  rest, least privilege, plan revocation.
- **Supervisor scale** — single asyncio worker is fine into low-thousands of
  mailboxes; beyond that, shard workers.
