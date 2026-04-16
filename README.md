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
CLI. Both IMAP and Gmail API are supported, along with Microsoft Graph for
Office 365 / Outlook accounts. The app polls your accounts regularly and
sends notifications for important emails via Telegram. The same database
tracks which emails have been processed so restarts don't produce duplicates.

## Installation

This project was developed and tested with Python 3.13.2 on macOS Sonoma with
an M3 MacBook. No guarantees are made for other environments. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then sync
dependencies:

```bash
uv sync
```

## Setup

All setup happens through the `sentinel` CLI — no YAML or `.env` files.

### 1. Gather credentials

- **OpenAI API key** — from [platform.openai.com](https://platform.openai.com/api-keys).
- **Telegram bot** — create one via [`@BotFather`](https://t.me/BotFather),
  grab the token, message the bot once, then hit
  `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat ID.
- **Gmail accounts** — create an OAuth 2.0 Desktop client in the
  [Google Cloud Console](https://console.cloud.google.com/) with the Gmail API
  enabled, and download the client JSON.
- **Microsoft 365 / Outlook accounts** — register an app in Azure AD with
  `Mail.ReadWrite` (delegated) and note its client ID + tenant ID.
- **IMAP accounts** — server, port, username, and (app-)password.

### 2. First-time app setup

```bash
uv run sentinel init
```

You'll be prompted for the OpenAI key, Telegram credentials, and a few
monitoring preferences. Everything is stored in `sentinel.db`.

### 3. Add mail accounts

Run this once per mailbox you want to monitor:

```bash
uv run sentinel account add
```

Pick a provider and follow the prompts. For Gmail you'll be asked for the
path to the OAuth client JSON (its contents are copied into the database —
you can delete the file afterwards). For MS Graph you'll enter the Azure
client/tenant IDs. For IMAP you'll provide the server details and password.

Other account commands:

```bash
uv run sentinel account list
uv run sentinel account remove <name>
```

### 4. Run the monitor

```bash
uv run sentinel run
```

The first run will complete any outstanding OAuth flows (Gmail / MS Graph
open a browser), then begin polling. Refreshed tokens are written back to
the database automatically.

### Web UI (optional)

For a browser-based view of the daemon's status and a place to edit
settings / classification notes / toggle accounts, run:

```bash
uv run sentinel web
```

Binds 127.0.0.1:8765 by default (`--host` / `--port` to override). No
auth — keep it on localhost. Changes to app settings or accounts take
effect at the next daemon restart.

### Configuring the database location

By default the database lives at `./sentinel.db`. Override with:

```bash
export DATABASE_PATH=/var/lib/sentinel/sentinel.db
```

This is the only environment variable Sentinel reads.

## Roadmap

- Allow customizing classification rules per account.
- Support for different LLM providers (currently uses OpenAI; Anthropic,
  local models, etc. would be straightforward).
- A hosted offering with a web UI on top of the same configuration schema.
