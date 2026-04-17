# Email Sentinel
> An intelligent email notification system to find what matters

## Problem

Many people, including me, receive LOTS OF EMAIL. Core life activities like
business, education, and job searching happen over email. However, email also
accumulates impersonal spam and mass emails, making it overwhelming to manage.

Common email clients offer functionality to mark emails as important, but it's
not very good. Gmail uses heuristics like how often you email a sender, open
rate, etc... [[1]](https://support.google.com/mail/answer/186543) to
categorize which email is important, which is only decent.

I want to be able to respond to important stuff fast, while not overwhelming
myself.

## Why use an LLM?

LLMs can intelligently classify emails and their behavior can be controlled
with plain English prompts. I want to be able to set custom rules to manage
their email that match my specific workflow - something existing filters
can't do.

## Solution

An app that reads all incoming emails, decides if each is important, and
sends an appropriate notification for the ones that are.

This app should be configurable to monitor many mailboxes simultaneously. For
example, for my personal use case, it will monitor my Purdue email and my
personal Gmail.

An LLM will do this task better than the traditional Bayesian filters. People
will also be able to adjust the classification criteria to their needs.

## Features

Email Sentinel classifies your emails using OpenAI's Responses API (default
model: GPT 5.4). All configuration — API keys, mail accounts, OAuth tokens,
preferences — lives in a single SQLite database, managed through a guided
CLI and a minimal web UI. IMAP, Gmail API, and Microsoft Graph providers
are all supported. The app polls your accounts regularly and sends
notifications for important emails via Telegram. The same database tracks
which emails have been processed so restarts don't produce duplicates.

## Project layout

```
src/
  sentinel_core/     engine — classifier, monitor, db, streams, notifiers, telegram bot
  sentinel_app/     UI — CLI + Flask web app + auth providers
```

The engine has no dependency on the UI layer, so the same code can be reused
behind a different surface (Slack app, TUI, etc.) later.

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

### 2. Add a mail account

```bash
uv run sentinel account add
```

Pick **IMAP** for Gmail/iCloud/Fastmail/Outlook.com/Yahoo (with an
[app password](#getting-an-app-password)), or one of the OAuth providers
for the rare case you've already verified an app with Google or Azure.

You can also add accounts through the web UI (see step 4).

### 3. Run the monitor

```bash
uv run sentinel run
```

Polls every account on the configured interval, classifies new mail with
OpenAI, and pings Telegram on IMPORTANT items. Refreshed OAuth tokens are
written back to the database automatically.

### 4. Open the web UI (optional but recommended)

```bash
uv run sentinel web
```

Opens on `http://127.0.0.1:8765`. No login required in local mode. From
there you can:
- See daemon status and recently-processed emails
- Add/disable/delete mail accounts
- Edit your classification notes (appended to the LLM prompt every time)
- Link your Telegram chat in one click

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

`sentinel account add/list/remove --user-email <user@example.com>` lets
the operator manage a specific user's mail accounts from the shell.

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

- Generalize `EmailClient` → `Stream` and add non-email datastreams
  (RSS, GitHub notifications, Slack, etc.) under `sentinel_core/streams/`.
- Per-account classification rules.
- Support for different LLM providers (currently OpenAI; Anthropic,
  local models, etc. would be straightforward).
