# Sentinel
> An intelligent notification system to find what matters

Sentinel is a program to monitor many datastreams from the internet (email,
news, RSS, social media) and alert the user when something relevant is
detected.

Most of us drown in signal from too many sources — email, RSS/news feeds,
GitHub notifications, chat mentions. The stuff that matters is mixed in with
newsletters, spam, and low-value updates. Responding fast to the important
things without drowning in the rest is an unsolved problem per-source, and
nobody stitches them together coherently.

Sentinel subscribes to *streams* — email mailboxes, RSS feeds, and more to
come — runs every new item through an LLM-backed classifier, and pings you
over Telegram when something is actually important. Classification criteria
are plain-English notes you control.

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

### 2. Add a stream

```bash
uv run sentinel stream add --type email   # IMAP / Gmail API / MSGraph
uv run sentinel stream add --type rss     # any RSS or Atom feed
```

For email, pick **IMAP** (with an [app password](#getting-an-app-password))
unless you've already verified an app with Google or Azure.

For RSS, paste the feed URL and a poll interval.

You can also add streams through the web UI once it's running.

### 3. Run the monitor

```bash
uv run sentinel web
```

This is the one command you need. `sentinel web` runs the supervisor
in-process alongside the Flask app, so there's no second daemon to manage.
Open `http://127.0.0.1:8765`. No login required. From there you can:
- Watch the live feed as items arrive and get classified in real time
- See daemon status and recently-processed items
- Add/disable/delete streams (email or RSS)
- Edit your classification notes (appended to the LLM prompt every time)
- Link your Telegram chat in one click

For a purely headless deployment (no web UI), `sentinel run` spawns just
the supervisor. Don't run both at once — you'll get two supervisors and
duplicate notifications.

For UI load testing, you do not need to wait on real RSS publishers. Emit a
synthetic firehose straight into the local sqlite store:

```bash
uv run sentinel dev firehose --rate 20 --count 200
```

This produces `item_received` and `item_classified` events that the
dashboard renders the same way as real traffic. Use `--count 0` to run until
you stop it.

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

Defaults to `./sentinel-local.db`. Override with:

```bash
export DATABASE_PATH=/var/lib/sentinel/sentinel.db
```

---

## Multi-tenant runtime

The repo also includes a separate multi-tenant runtime (`sentinel-hosted`)
with Google OAuth, per-user storage, and a worker/web split. It is **not in
active development** — use the single-user setup above unless you have a
reason to dig into the hosted code.

---

# TODO

Figure out X scraping. That's the most valuable data source we haven't unlocked.

https://huggingface.co/Qwen/Qwen3-Embedding-0.6B

Improve cascade classifier to be
    logistic regression -> local LLM -> API LLM

Figure out Instagram scraping.


uv run hf auth login
