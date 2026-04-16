# To-do

Everything known to be outstanding. Priorities are rough; re-order as needed.

## Features

- **Per-account classification rules.** Move the hardcoded prompt out of
  `EmailClassifier._create_classification_prompt` into `AccountSettings` as
  an editable string. Each account gets its own "what's important to me"
  list. Biggest user-facing value add and the natural shape for the hosted
  UI to expose.
- **Deep links for MSGraph and IMAP.** Only Gmail populates `EmailData.url`
  today. MSGraph messages have a `webLink` field; IMAP can't produce a true
  deep link, but can fall back to a provider-specific webmail URL where
  configured.
- **Persist classification results.** Today they're thrown away after the
  notifier call. Add `priority`, `summary` columns to `processed_emails`
  so history is queryable — useful for debugging and a precondition for
  any future "review my recent classifications" UI.

## Correctness / hygiene

- **Wire DB-backed logging settings.** `Settings.LOG_LEVEL`, `LOG_DIR`, and
  `DISABLE_FILE_LOGGING` are populated from `app_settings` but
  `logging_config.py` ignores them in favor of env vars. Either honor the
  DB values after `Settings.load(db)` or delete the unused fields.
- **Cap email body before sending to the LLM.** The classifier hands the
  full body into the Responses API; a long newsletter or quoted thread can
  hit token limits or inflate cost. Truncate to ~8KB with an ellipsis
  (after header extraction, not before).
- **Retry + backoff on transient failures.** OpenAI 429/5xx, Telegram
  network blips, and Gmail API rate limits all currently raise straight to
  the monitor loop's broad `except Exception` which then sleeps the whole
  poll interval. Add targeted retry (with jitter) at each boundary.
- **Dedicated exception types.** The codebase raises bare `Exception(...)`
  in several places (Gmail client, IMAP client, monitor). A small
  hierarchy — `ProviderError`, `AuthError`, `ClassificationError` — would
  let the monitor branch intelligently instead of catch-all.

## Testing

Nothing exists today. Scaffold a pytest suite:

- `tests/test_database.py` — schema + CRUD for both config tables and
  monitoring state.
- `tests/test_config.py` — `Settings.load` type coercion, `validate()`.
- `tests/test_mail_config.py` — `MailAccountConfig` validation per provider;
  `MailboxesConfig.from_db` round-trip.
- `tests/test_factory.py` — token-persister callback writes refreshed
  token back to the db.
- `tests/test_monitor.py` — mock classifier + client + notifier; verify
  IMPORTANT notifies, NORMAL doesn't, and already-processed is skipped.
- `tests/test_classifier.py` — mock `client.responses.parse`; verify
  schema round-trip and `ClassificationResult` mapping.
- Live MSGraph path untested end-to-end; Live IMAP password auth
  untested end-to-end. Gate these behind env-var-supplied credentials so
  CI doesn't run them by default.

## Open-core / public release

- **Pick a license.** AGPL-3.0 for "self-host OK, no commercial resale";
  MIT/Apache-2.0 for maximum adoption. Decision needed before the repo
  goes public.
- **Update CONTRIBUTING.md.** Currently stale relative to the new CLI and
  db-backed config.
- **Reconcile with origin/master.** Branch is well ahead of remote; pull
  or rebase before pushing.

## Hosted tier (deferred — design first, build later)

- **Multi-tenancy.** Add a `users` table and scope `app_settings`,
  `accounts`, `processed_emails`, `monitoring_state` by `user_id`. Pydantic
  shapes stay identical; only the SQL layer changes.
- **Postgres backend.** Swap SQLite for Postgres behind the same
  `EmailDatabase` surface.
- **Managed OAuth app.** Register one Google + one Azure OAuth client for
  the hosted service so users don't need to stand up their own GCP / Azure
  projects.
- **Web UI.** Replaces the CLI for hosted users; writes to the same
  configuration schema.
- **Auth + billing.** Separate concern; scope after everything above is
  clear.
