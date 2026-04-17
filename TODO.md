# To-do

Everything known to be outstanding. Priorities are rough; re-order as needed.

## Features

- **Generalize `EmailClient` → `Stream` and `EmailData` → `Item`.** Currently
  the streams package only contains `streams/email/`. When the second stream
  type lands (RSS, GitHub notifications, Slack, etc.) we need to extract a
  generic `Stream` ABC — `fetch_new(after_timestamp) → list[Item]` — at
  `sentinel_core/streams/base.py`, with an `Item` dataclass holding
  `id`/`source_type`/`text`/`metadata`/`url`. `EmailData` becomes a
  specialization. The classifier prompt should adapt by source type.
- **RSS / Atom datastream.** Lowest-friction next source (no auth, no API
  limits). Lives at `sentinel_core/streams/rss/`. Use as the shake-out for
  the `Stream` abstraction above.
- **GitHub notifications datastream.** Token-based auth, well-documented
  REST API. High signal for devs.
- **Per-account classification rules.** Move classification preferences from
  per-user (`CLASSIFICATION_NOTES`) to per-account, so different mailboxes
  can have different "what's important" criteria.
- **Deep links for MSGraph and IMAP.** Only Gmail populates `EmailData.url`
  today. MSGraph messages have a `webLink` field; IMAP can't produce a true
  deep link, but can fall back to a provider-specific webmail URL where
  configured.
- **Persist classification results.** Today they're thrown away after the
  notifier call. Add `priority`, `summary` columns to `processed_emails`
  so history is queryable — useful for debugging and a precondition for
  any future "review my recent classifications" UI.
- **Email-as-notification-channel** via Resend. Schema (`EMAIL_NOTIFICATION_TO`)
  + UI already exist; need to wire the actual Resend send into the
  monitor's `_build_notifier` for users who set it.

## Correctness / hygiene

- **Wire DB-backed logging settings.** `Settings.LOG_LEVEL`, `LOG_DIR`, and
  `DISABLE_FILE_LOGGING` are populated from `app_settings` but
  `logging_config.py` ignores them in favor of env vars. Either honor the
  DB values after `Settings.load(db)` or delete the unused fields.
- **Retry + backoff on transient failures.** OpenAI 429/5xx, Telegram
  network blips, and Gmail API rate limits all currently raise straight to
  the monitor loop's broad `except Exception` which then sleeps the whole
  poll interval. Add targeted retry (with jitter) at each boundary.
- **Dedicated exception types.** The codebase raises bare `Exception(...)`
  in several places (Gmail client, IMAP client, monitor). A small
  hierarchy — `ProviderError`, `AuthError`, `ClassificationError` — would
  let the monitor branch intelligently instead of catch-all.
- **Daemon picks up config changes without restart.** Currently the monitor
  loads `Settings` and accounts once at startup. Web UI edits don't take
  effect until `sentinel run` is restarted. Reload at the top of each
  poll tick.
- **Encrypt IMAP app passwords at rest.** App passwords give full mail
  access. Today they're plaintext in `accounts.config_json`. For hosted
  deployment, encrypt with a key in the env (not the database) before
  storing.

## Testing

Nothing exists today. Scaffold a pytest suite:

- `tests/test_database.py` — schema + CRUD for users / app_settings /
  user_settings / accounts / processed_emails / monitoring_state /
  telegram_link_tokens.
- `tests/test_config.py` — `Settings.load` type coercion, mode-aware
  `validate()`.
- `tests/test_mail_config.py` — `MailAccountConfig` validation per provider;
  `MailboxesConfig.from_db` round-trip.
- `tests/test_factory.py` — token-persister callback writes refreshed
  token back to the db scoped by user_id.
- `tests/test_monitor.py` — mock classifier + client + notifier; verify
  IMPORTANT notifies, NORMAL doesn't, already-processed skipped, one
  user's failure doesn't break others.
- `tests/test_classifier.py` — mock `client.responses.parse`; verify
  schema round-trip and `ClassificationResult` mapping.
- `tests/test_telegram_link.py` — link-token create/consume/expire/purge.
- `tests/test_web_auth.py` — LocalIdentity injects singleton;
  GoogleOAuthIdentity gates routes; mode switch picks the right one.
- Live MSGraph path untested end-to-end. Gate behind env-var-supplied
  credentials so CI doesn't run it by default.

## Public release

- **Pick a license.** AGPL-3.0 for "self-host OK, no commercial resale";
  MIT/Apache-2.0 for maximum adoption. Decision needed before the repo
  goes public.
- **Update CONTRIBUTING.md.** Currently stale relative to the new CLI and
  db-backed config.
- **Reconcile with origin/master.** Branch is well ahead of remote; pull
  or rebase before pushing.

## Hosted tier (designed; partially shipped)

Done:
- Multi-tenancy schema (users, user_settings, user_id FKs everywhere).
- Google OAuth signup/login (identity scopes only — no Gmail-API
  verification needed).
- Per-user web UI (preferences, prompt notes, accounts).
- Shared operator Telegram bot with one-click linking.
- Account-creation flow over IMAP from the web UI (no Gmail API verification
  needed for any provider).

Still outstanding:
- **Postgres backend.** Swap SQLite for Postgres behind the same
  `EmailDatabase` surface (the API is already user-scoped — only the
  driver changes).
- **Per-user worker isolation.** One user's slow IMAP shouldn't stall the
  others. Currently the monitor processes users sequentially in one tick.
- **Auth + billing.** Stripe + usage metering + plan tiers + free-tier
  cost guards.
- **Privacy policy + Terms of Service.** Required before opening signup.
- **Operational basics.** Hosting (Fly.io/Render/Railway), managed Postgres,
  secret storage, error tracking (Sentry), uptime monitoring, on-call,
  backups, status page.
- **Onboarding UX polish.** Provider-specific app-password setup walkthroughs
  with screenshots.
