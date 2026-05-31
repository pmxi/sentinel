# Sentinel
> An intelligent notification system to find what matters

Sentinel is a program to monitor your email inbox and alert you when
something relevant arrives.

Sentinel is designed to give you the confidence to step away from your inbox.

Most of us drown in email. The stuff that matters is mixed in with
newsletters, spam, and low-value updates. Responding fast to the important
things without drowning in the rest is the problem Sentinel solves.

Sentinel watches your email mailboxes, runs every new message through an
LLM-backed classifier, and pings you over Telegram when something is
actually important. Classification criteria are plain-English notes you
control.

## How do I use this?

Sentinel is in-progress. You may sign up at sentinel.parasmittal.com.

Tested with Python 3.14.2 on macOS. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then sync
dependencies:

```bash
uv sync
```

---

## Quick start

### 1. Configure

Sentinel is configured entirely through environment variables — copy the
template and fill it in:

```bash
cp .env.example .env
```

At minimum set `DATABASE_URL`, `OPENAI_API_KEY`, and (for sign-in /
Connect-Gmail) the Google OAuth creds. See `.env.example` for the full list
and `development.md` for the Google Cloud setup.

### 2. Start Postgres

Sentinel needs a PostgreSQL database (18+). On macOS via Homebrew:

```bash
brew install postgresql@18
brew services run postgresql@18   # runs for this session, no boot-time daemon
createdb sentinel                 # one-time; psql tools live in /opt/homebrew/opt/postgresql@18/bin
```

(`brew services stop postgresql@18` when you're done.) The schema is applied
automatically on first connect.

### 3. Run the dev server

```bash
uv run sentinel-web
```

That's the one command you need. It serves the web console at
**http://localhost:8765** and — when `OPENAI_API_KEY` is set — runs the
classification worker in-process, so there's no second daemon to manage.

> Open it as `localhost`, **not** `127.0.0.1`. Google OAuth redirects back to
> the `localhost` callback, and browser session cookies are host-specific —
> mixing the two breaks sign-in with an "OAuth state mismatch" error.

Open the link, **sign in with Google**, then from the console you can:
- Connect inboxes — **Gmail via OAuth** (`gmail.readonly`), or any provider
  via an [app password](#getting-an-app-password)
- Edit your classification criteria (plain-English notes that drive the LLM)
- Link your Telegram chat in one click

The console never displays your email — alerts go out-of-band over Telegram.

#### Running the worker separately (optional)

For production scale you typically run multiple stateless web processes, so
the embedded worker is turned off and the supervisor runs on its own:

```bash
SENTINEL_EMBED_WORKER=false uv run sentinel-web     # web only
uv run sentinel-worker                               # the supervisor
```

In dev you don't need this — a single `sentinel-web` does both. Don't run an
embedded `sentinel-web` *and* a standalone `sentinel-worker` at once, or
you'll get two supervisors and duplicate notifications.

---

## Getting an app password

For IMAP, you need an app password from your provider — your normal
account password won't work. Quick links:

- **Gmail:** [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (2-Step Verification must be on)
- **iCloud:** [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords
- **Fastmail:** [app.fastmail.com/settings/security](https://app.fastmail.com/settings/security) → New app password
- **Outlook.com:** [account.microsoft.com/security](https://account.microsoft.com/security)
- **Yahoo:** [login.yahoo.com/account/security](https://login.yahoo.com/account/security)

Microsoft 365 enterprise tenants disable basic IMAP auth — those
require OAuth (XOAUTH2), not yet supported.

---

## Configuration

Sentinel uses PostgreSQL for the active single-user runtime. Configure it with
`DATABASE_URL`:

```bash
export DATABASE_URL=postgresql://sentinel_user:REDACTED@localhost:5433/sentinel
```
