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

The repo is split into a pure shared library plus separate local and hosted
runtimes. The local runtime is single-user and can back both a CLI and a
local web UI with one SQLite database. The hosted runtime is multi-user and
has its own storage model, web app, and worker process.

## Project layout

```
src/
  sentinel_lib/      shared library — streams, classifiers, processing, notifiers
    streams/
      base.py        Stream + Item
      email/         IMAP / Gmail API / Microsoft Graph
      rss/           RSS + Atom feeds via feedparser
  sentinel_local/    single-user runtime — SQLite, CLI, local web app
  sentinel_hosted/   multi-user runtime — hosted web app, worker, auth
```

`sentinel_lib` has no dependency on the runtime or UI layers. Both local and
hosted runtimes compose it differently instead of sharing one mode-switched
application.

## Installation

Tested with Python 3.13 on macOS. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then sync
dependencies:

```bash
uv sync
```

Sentinel has two separate runtimes:

- **Local** — single user, no auth, for personal use.
- **Hosted** — multi-tenant, Google OAuth signup/login.

---

## Quick start (self-hosted, single-user)

### 1. Configure operator-level settings

```bash
uv run sentinel init
```

You'll be asked for:
- **OpenAI API key** (required) — from
  [platform.openai.com](https://platform.openai.com/api-keys)
- **Telegram bot** (optional) — create one via
  [`@BotFather`](https://t.me/BotFather), paste the token + bot username
- **Resend API key** (optional) — for transactional email; from
  [resend.com](https://resend.com)
- **Monitoring preferences** — poll interval, max lookback hours

The local runtime is single-user; there is no app-level login.

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
uv run sentinel-hosted init
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
uv run sentinel-hosted worker   # one terminal — worker + Telegram bot listener
uv run sentinel-hosted web      # another — public web UI
```

Users sign up by clicking "Sign in with Google" on `/login`. After
signing in they configure their own mail accounts, classification notes,
and Telegram link via the web UI — operator-level secrets stay private.

### CLI for operators

The hosted admin CLI currently handles runtime setup plus starting the web
and worker processes.

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

The local runtime defaults to `./sentinel-local.db`. The hosted runtime
defaults to `./sentinel-hosted.db`. Override either with:

```bash
export DATABASE_PATH=/var/lib/sentinel/sentinel.db
```

`DATABASE_PATH` is intentionally runtime-scoped: point the local and hosted
processes at different files if you run both on one machine.

## Roadmap

- More streams: GitHub notifications, Slack mentions, Bluesky Jetstream,
  Wikipedia EventStreams — push sources will slot in as async generators
  alongside the pull streams.
- Per-stream classification rules.
- Support for different LLM providers (currently OpenAI; Anthropic,
  local models, etc. would be straightforward).
