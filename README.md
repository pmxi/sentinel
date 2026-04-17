# Sentinel
> An intelligent notification system to find what matters across every stream you care about

## Problem

Most of us drown in signal from too many sources — email, RSS/news feeds,
GitHub notifications, chat mentions. The stuff that matters is mixed in with
newsletters, spam, and low-value updates. Responding fast to the important
things without drowning in the rest is an unsolved problem per-source, and
nobody stitches them together coherently.

## Solution

Sentinel subscribes to *streams* — email mailboxes, RSS feeds, and more to
come — runs every new item through an LLM-backed classifier, and pings you
over Telegram when something is actually important. Classification criteria
are plain-English notes you control.

The streams abstraction is simple: anything that produces items over time
can be plugged in. Today: email (IMAP / Gmail API / Microsoft Graph) and RSS
/ Atom feeds. On the roadmap: GitHub notifications, Slack mentions, Bluesky
firehose, and more.

## Features

All configuration — API keys, streams, OAuth tokens, preferences — lives in
a single SQLite database, managed through a guided CLI and a minimal web UI.
The daemon is an async supervisor that runs one task per stream; push-native
sources (WebSockets, SSE) will slot in alongside pull-based ones without
changes to the supervisor.

## Project layout

```
src/
  sentinel_core/     engine — Stream ABC, Item, classifier, async supervisor, db, notifiers
    streams/
      base.py        Stream + Item
      registry.py    stream_type → (config, class) registry
      email/         IMAP / Gmail API / Microsoft Graph
      rss/           RSS + Atom feeds via feedparser
  sentinel_app/      UI — CLI + Flask web app + auth providers
```

The engine has no dependency on the UI layer, so the same code can be reused
behind a different surface (Slack app, TUI, etc.) later. Adding a new
datastream is a matter of implementing `Stream` + a Pydantic config and
registering the pair in `streams/registry.py`.

## Installation

Tested with Python 3.13 on macOS. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then sync
dependencies:

```bash
uv sync
```

Sentinel runs in two modes — pick one when you set it up:

- **`local`** — single user, no auth, you run it for yourself. Default.
- **`hosted`** — multi-tenant, Google OAuth signup/login.

---

## Quick start (self-hosted, single-user)

### 1. Configure operator-level settings

```bash
uv run sentinel init --local
```

You'll be asked for:
- **OpenAI API key** (required) — from
  [platform.openai.com](https://platform.openai.com/api-keys)
- **Telegram bot** (optional) — create one via
  [`@BotFather`](https://t.me/BotFather), paste the token + bot username
- **Resend API key** (optional) — for transactional email; from
  [resend.com](https://resend.com)
- **Monitoring preferences** — poll interval, max lookback hours

A singleton "local" user is created automatically; you'll never need to log in.

### 2. Add a stream

```bash
uv run sentinel stream add --type email   # IMAP / Gmail API / MSGraph
uv run sentinel stream add --type rss     # any RSS or Atom feed
```

For email, pick **IMAP** (with an [app password](#getting-an-app-password))
unless you've already verified an app with Google or Azure.

For RSS, paste the feed URL and a poll interval.

You can also add streams through the web UI (see step 4).

### 3. Run the monitor

```bash
uv run sentinel web
```

This is the one command you need in local mode. `sentinel web` runs the
supervisor in-process alongside the Flask app, so there's no second daemon
to manage. Open `http://127.0.0.1:8765`. No login required. From there you
can:
- Watch the live feed as items arrive and get classified in real time
- See daemon status and recently-processed items
- Add/disable/delete streams (email or RSS)
- Edit your classification notes (appended to the LLM prompt every time)
- Link your Telegram chat in one click

For a purely headless deployment (no web UI), `sentinel run` still exists
and spawns just the supervisor. Don't run both at once in local mode — you
get two supervisors and duplicate notifications.

---

## Hosted deployment (multi-tenant)

For running Sentinel as a service for multiple users:

### 1. Configure operator-level settings

```bash
uv run sentinel init --hosted
```

In addition to the local-mode prompts, you'll need:
- **Google OAuth Client ID + Secret** — register a Web application OAuth
  client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
  Add `http://127.0.0.1:8765/auth/google/callback` (and your prod URL) to
  Authorized redirect URIs. Identity scopes only (`openid email profile`)
  — no Google verification process needed.

A `SESSION_SECRET` is auto-generated and persisted on first run.

### 2. Run the daemon and web UI

```bash
uv run sentinel run        # one terminal — daemon + Telegram bot listener
uv run sentinel web        # another — public web UI
```

Users sign up by clicking "Sign in with Google" on `/login`. After
signing in they configure their own mail accounts, classification notes,
and Telegram link via the web UI — operator-level secrets stay private.

### CLI for operators

`sentinel stream add/list/remove --user-email <user@example.com>` lets
the operator manage a specific user's streams from the shell.

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

The database lives at `./sentinel.db` by default. Override with:

```bash
export DATABASE_PATH=/var/lib/sentinel/sentinel.db
```

This is the only environment variable Sentinel reads. Everything else
lives in the database and is editable via the CLI or web UI.

## Roadmap

- More streams: GitHub notifications, Slack mentions, Bluesky Jetstream,
  Wikipedia EventStreams — push sources will slot in as async generators
  alongside the pull streams.
- Per-stream classification rules.
- Support for different LLM providers (currently OpenAI; Anthropic,
  local models, etc. would be straightforward).
