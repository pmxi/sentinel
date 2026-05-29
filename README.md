# Sentinel
> An intelligent notification system to find what matters

Sentinel is a program to monitor your email inbox and alert you when
something relevant arrives.

Most of us drown in email. The stuff that matters is mixed in with
newsletters, spam, and low-value updates. Responding fast to the important
things without drowning in the rest is the problem Sentinel solves.

Sentinel watches your email mailboxes, runs every new message through an
LLM-backed classifier, and pings you over Telegram when something is
actually important. Classification criteria are plain-English notes you
control.

## Installation

Tested with Python 3.14.2 on macOS. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then sync
dependencies:

```bash
uv sync
```

---

## Quick start

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

Single-user; there is no app-level login.

### 2. Add a mailbox

```bash
uv run sentinel stream add   # IMAP / Gmail API / MSGraph
```

Pick **IMAP** (with an [app password](#getting-an-app-password)) unless
you've already verified an app with Google or Azure.

You can also add mailboxes through the web UI once it's running.

### 3. Run the monitor

```bash
uv run sentinel web
```

This is the one command you need. `sentinel web` runs the supervisor
in-process alongside the Flask app, so there's no second daemon to manage.
Open `http://127.0.0.1:8765`. No login required. From there you can:
- Watch the live feed as items arrive and get classified in real time
- See daemon status and recently-processed items
- Add/disable/delete mailboxes
- Edit your classification notes (appended to the LLM prompt every time)
- Link your Telegram chat in one click

For a purely headless deployment (no web UI), `sentinel run` spawns just
the supervisor. Don't run both at once — you'll get two supervisors and
duplicate notifications.

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
