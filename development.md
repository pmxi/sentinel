# Sentinel — development roadmap

Sentinel is becoming a **multi-tenant hosted SaaS**: users sign up with Google,
connect their Gmail via OAuth, and Sentinel monitors their inbox and alerts
them (out-of-band) when something important arrives.

The classification engine (`EmailStream` → `OpenAIItemClassifier` → notify,
driven by the supervisor in `monitor.py`) is reused as-is and wrapped in a
tenancy + auth shell.

## Status (2026-05-29)

**Built:**
- Web app stripped to a single, login-gated **control console** — connect
  inboxes, edit classification criteria, link Telegram. No email content is
  shown anywhere (the old dashboard / live feed / alerts pages + SSE bus are gone).
- **Google sign-in** (OIDC) + sessions + login gating.
- **Connect Gmail** via OAuth `gmail.readonly`; IMAP app-password kept as a
  secondary connect path; multiple inboxes per user.
- Multi-tenant DB foundation: `app_user`, per-user criteria + telegram_chat_id,
  `stream.user_id`.
- Classifier: `gpt-5.4-mini`, reasoning effort `medium` (verified live).

**Next:** Phase 4 — make the worker per-user, wire Telegram link-token → user,
and turn classification on.

**Not working end-to-end yet:** a connected inbox is *not* polled / classified /
alerted — the worker still uses global prefs and `_CLASSIFICATION_DISABLED=True`.

## Running it locally (dev)

Prereqs: Postgres 18 (Homebrew), `uv`, and a filled-in `.env` (see `.env.example`).

```bash
cp .env.example .env               # fill in DATABASE_URL, OPENAI_API_KEY, Google creds
createdb sentinel                  # one-time (psql tools at /opt/homebrew/opt/postgresql@18/bin)
brew services run postgresql@18    # start DB for the session, no-boot (`stop` when done)
uv run sentinel-web                # → http://localhost:8765  (Ctrl-C to stop)
```

`sentinel-web` reads `.env`, applies `schema.sql` on connect, serves the console,
and — when `OPENAI_API_KEY` is set and `SENTINEL_EMBED_WORKER=true` (the
default) — runs the supervisor in-process. To run them apart:
`SENTINEL_EMBED_WORKER=false` + a separate `uv run sentinel-worker`.

## Architecture (target)

```
Google OIDC →  WEB (Flask): login/session, console (connect inboxes,
               edit criteria, link Telegram), "flagged" list
                     │  shared Postgres (everything scoped by user_id)
Gmail API   ←  WORKER (asyncio supervisor): polls every connected
 (readonly)    mailbox, classifies (operator's OpenAI key), fires
               out-of-band notifications, persists only decisions
```

The engine is reused largely as-is; it just becomes user-scoped. Web and worker
are separate processes sharing one DB.

## Locked design decisions

1. **Login ≠ Gmail access; incremental auth.** Sign in with Google using basic
   OIDC scopes (`openid email profile`); a separate "Connect Gmail" step
   requests `gmail.readonly` only on opt-in. *(done)*
2. **`gmail.readonly`, no "mark as read."** We never mutate a user's inbox.
3. **Don't store email content.** Process in memory; persist only *decisions*.
   We keep a record of the **alerts we sent** (sender, subject, reason — derived,
   not the body), never the inbox itself. Dedup is a ledger of opaque message-ids.
   In dev it's OK to store raw email behind a flag, but no UI may depend on it.
4. **Notifications are out-of-band — never email.** One shared Sentinel bot on
   Telegram; per-user delivery by `chat_id`, established via a link-token. Plus
   an in-app "flagged" list that reads only the alert table. Resend channel removed.
5. **The web app is a control console, not a data viewer** — no live feed of
   email.
6. **Operator config via env, no interactive CLI** (`sentinel-web` / `sentinel-worker`).
7. **Web/worker separate processes** (toggle with `SENTINEL_EMBED_WORKER`).
8. **Classifier `gpt-5.4-mini`, reasoning `medium`** (`LLM_MODEL`,
   `LLM_REASONING_EFFORT`).
9. **Classification must be turned ON** (`_CLASSIFICATION_DISABLED=False`) for the
   product — currently off.

## mvp plan

- sign up with google
- connect gmail
- configure prompt
- openai api to classify new emails with prompt
- send telegram message
- hosted at sentinel.parasmittal.com


## Google OAuth setup (project `email-sentinel-mvp`)

- Google Cloud project **email-sentinel-mvp**, Gmail API enabled.
- A **Web** OAuth client; `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.
- Registered redirect URIs:
  - `http://localhost:8765/oauth/google/callback` (dev)
  - `https://sentinel.parasmittal.com/oauth/google/callback` (prod)
- Consent screen is External + unverified: add your Google account as a **Test
  user**, and expect an "unverified app" warning on the `gmail.readonly`
  restricted scope until verification completes (see external track).

## External track (gates launch)

- **Google OAuth verification + CASA security assessment** for the Gmail scope.
  Capped at ~100 test users until verified; takes weeks–months and recurs.
  Often the real launch bottleneck, not the code.
- Privacy policy + ToS (required for verification).

## Risks to design for

- **Secrets at rest (open gap).** Gmail refresh tokens and IMAP app passwords
  are stored unencrypted in `stream.config_json`. Encrypt before any real
  multi-user use — a DB leak = access to users' inboxes.
- **LLM cost scales with users × inbox volume.** Levers: classify only unread /
  Primary-category mail, cheaper model, batching, or a cheap pre-filter (the
  removed local scorer was exactly this hedge).
- **Supervisor scale** — single asyncio worker is fine into low-thousands of
  mailboxes; beyond that, shard workers.
