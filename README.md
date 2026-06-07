# Sentinel
> An intelligent notification system to find what matters

Sentinel is a program to monitor your email inbox and alert you when
something relevant arrives. It relies on OpenAI's `gpt-5.4-mini` model for classification.

Sentinel is designed to give you the confidence to step away from your inbox.

Most of us drown in email. The stuff that matters is mixed in with
newsletters, spam, and low-value updates. Responding fast to the important
things without drowning in the rest is the problem Sentinel solves.

Sentinel watches your email mailboxes, runs every new message through an
LLM-backed classifier, and sends you a Web Push notification when something is
actually important. Classification criteria are plain-English notes you
control.

## How do I use this?

Sentinel is in-progress. You may sign up at sentinel.parasmittal.com.
This is limited to 100 test users, and availability is not guaranteed.

You can also host it yourself. `development.md` may contain useful information for you.

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

At minimum set `DATABASE_URL`, `OPENAI_API_KEY`, the VAPID keys (for Web Push
alerts), and (for sign-in / Connect-Gmail) the Google OAuth creds. Generate the
VAPID keypair once and paste the output into `.env`:

```bash
uv run python -m sentinel.scripts.gen_vapid_keys
```

See `.env.example` for the full list and `development.md` for the Google Cloud
setup.

### 2. Start Postgres

Sentinel needs a PostgreSQL database (18+). On macOS via Homebrew:

```bash
brew install postgresql@18
brew services run postgresql@18   # runs for this session, no boot-time daemon
createdb sentinel                 # one-time; psql tools live in /opt/homebrew/opt/postgresql@18/bin
```

Use `brew services run` only — **not** `brew services start`. `run` keeps
Postgres up for this session; `start` registers a launchd agent that auto-starts
it on every login/boot, which you don't want for a dev dependency. Stop it with
`brew services stop postgresql@18` when you're done. The schema is applied
automatically on first connect.

### 3. Run the dev server

Sentinel runs as two processes — the web console and the classification
worker. `honcho` starts both from the `Procfile` in one command:

```bash
uv run honcho start
```

It serves the console at **http://localhost:8765** and runs the worker
alongside it, with labelled output (`web | …` / `worker | …`); Ctrl-C stops
both. This is the same two-process topology as production — just supervised
locally instead of by systemd.

To run them separately (e.g. in their own terminals), use the entry points
directly:

```bash
uv run sentinel-web      # web console only
uv run sentinel-worker   # polls inboxes, classifies, sends alerts
```

The console is usable on its own for connecting inboxes and editing criteria;
the worker is what actually classifies mail and sends the push alerts.

> Open it as `localhost`, **not** `127.0.0.1`. Google OAuth redirects back to
> the `localhost` callback, and browser session cookies are host-specific —
> mixing the two breaks sign-in with an "OAuth state mismatch" error.

The root URL is a public homepage; **sign in with Google** and a one-time
first-run walkthrough drops you on your dashboard (`/dashboard`), where you can:
- Connect inboxes — **Gmail via OAuth** (`gmail.readonly`), or any provider
  via an [app password](#getting-an-app-password)
- Edit your classification criteria (plain-English notes that drive the LLM)
- **Enable notifications** to receive Web Push alerts on that device

> **On iPhone/iPad:** Web Push only works from an installed app. In Safari, tap
> **Share → Add to Home Screen**, open Sentinel from the new icon, then tap
> **Enable notifications**. (A Safari tab alone won't receive alerts.) This also
> requires the console to be served over HTTPS in production.

The console never displays your email — alerts go out-of-band via Web Push.

> Run exactly one `sentinel-worker`. Two supervisors against the same database
> means duplicate notifications.

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
