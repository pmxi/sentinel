# Sentinel Code Audit

## Executive summary
Sentinel is a small, generally clean MVP, but it carries a layer of speculative generality and dead code that an MVP with no backwards-compat requirement should shed. The biggest wins are removing whole unused vertical slices — a hardcoded "classification disabled" kill-switch and its DB write path, a write-only `metadata` column, a single-value `inbox_type` discriminator, and unused schema-versioning machinery. None are correctness bugs; almost all are pure deletions that shrink the codebase and remove misleading APIs.

---

## 1. Dead code & unused vertical slices (highest leverage)

### Dead classification kill-switch drags an unused DB write path along with it — `medium`
`src/sentinel/monitor.py:32-35`, `monitor.py:332-335`, `monitor.py:403-405`, `database.py:221-226`

`_CLASSIFICATION_DISABLED` is a module constant hardcoded to `False`, with a comment confirming "classification is always on." The `if _CLASSIFICATION_DISABLED:` branch in `process()` is therefore unreachable. It is the only caller of `MessagePipeline._record_message`, which is the only caller of `Database.insert_message` — so an entire public DB method and a pipeline method exist solely to serve a branch that can never run.

**Fix:** Delete the constant + comment, the dead branch in `process()`, `MessagePipeline._record_message`, and `Database.insert_message`. Keep the private `_insert_message` — it is still used by `record_classified_message`/`record_failed_message`. (~25 lines removed.)

### `Message.metadata` is built and persisted but never read — `medium`
`src/sentinel/message.py:38`, `message.py:74-77`, `database.py:203-217`, `monitor.py:400`

`build_message` stuffs `{provider, recipient}` into `Message.metadata`, the pipeline forwards it, and the DB serializes it into a JSONB column — but nothing ever reads it back. The classifier reads `body`/`title`, the notifier reads `author`/`url`/`summary`, the web console never queries it. The `provider` parameter threaded into `build_message` from both clients exists *only* to populate this write-only field.

**Fix:** Drop the `metadata` field from `Message`, the `metadata` column from the message table, the `metadata` params from `_insert_message`, the `provider` parameter from `build_message`, and the `provider=` argument at both client call sites. Keep `build_message`'s `recipient` parameter — it still feeds the rendered body (`To: ...`), so nothing is lost.

### `inbox_type` is a single-value enum plumbed through five layers — `medium`
`src/sentinel/web/app.py:188`, `app.py:271`, `app.py:340`, `database.py:136-173`, `monitor.py:118`, `monitor.py:137-151`
(also: `schema.sql:22`, `monitor.py:181`, `console.html:11`)

Every inbox is written with the literal string `"email"` (the only two write sites both pass `"email"`). It is then carried through `upsert_inbox`/`list_inboxes`/`get_inbox`, the monitor's config-drift signature tuple, `_start_stream` logging, and `_build_stream` — yet the only branch keyed on it (`if row['inbox_type'] == 'email':` at app.py:340) is always true, and `_build_stream` ignores it and always builds an `EmailStream`. The real provider distinction (gmail vs imap) already lives in `MailAccountConfig.provider`. As an untyped magic string with no single source of truth, a typo in any writer would silently produce an inbox the view/monitor ignore.

**Fix:** Drop the `inbox_type` column and parameter entirely: remove it from `schema.sql`, all `Database` signatures, the monitor's signature tuple + log message + re-store at `monitor.py:181`, the `_inbox_view_rows` guard, and the `console.html:11` fallback. Collapses a column, a parameter across ~5 methods, a tuple element, and an always-true branch. (This subsumes the separate "magic literal `email`" finding — deletion is the right move over introducing a constant.)

### `schema_meta` / `schema_version` is written but never read — `low`
`src/sentinel/database.py:20`, `database.py:87-91`, `schema.sql:4`

`_CURRENT_SCHEMA_VERSION = 2` is inserted into a `schema_meta` table on every `_create_tables()` call, but nothing ever SELECTs it. There is no migration runner — schema is applied via idempotent `CREATE TABLE IF NOT EXISTS` DDL. This is an extensibility hook for a migration system that doesn't exist.

**Fix:** Remove `_CURRENT_SCHEMA_VERSION`, the `schema_meta` INSERT in `_create_tables` (collapsing it to a single `execute`), and the `schema_meta` table from `schema.sql`. `schema.sql` is the source of truth.

### Empty `services/` package with stale references — `low`
`src/sentinel/services/`, `config.py:5`

`src/sentinel/services/` contains no `.py` files (only stale `__pycache__` for a deleted `streams.py`/`__init__`). Nothing imports `sentinel.services`. Meanwhile `config.py`'s module docstring still points readers to a nonexistent `services/preferences.py`; preferences actually live on `app_user.criteria` via `Database`.

**Fix:** Delete the `src/sentinel/services/` directory and remove the `services/preferences.py` reference from the `config.py` docstring. (Note: there is only one reference, in the docstring at line 5 — no separate code comment.)

---

## 2. Speculative generality / single-value knobs

### `AccountSettings` is config plumbing nobody varies — `low`
`src/sentinel/email/mail_config.py:39-42`, `imap_client.py:43-49`, `web/app.py:269`

`folders` is typed `List[str]` defaulting to `['INBOX']`, but `imap_client` only ever reads `folders[0]`, and the Gmail client has no folder concept at all. The web UI is the sole creator of inboxes and always constructs `AccountSettings()` with defaults, so `folders` is never anything but `['INBOX']`, and `process_only_unread`/`max_lookback_hours` (consumed at `stream.py:105,121`) are always their defaults too.

**Fix:** Drop `folders` and hardcode `INBOX` selection in `imap_client.py` (clearest win). Optionally collapse the two scalar settings to module constants and remove `AccountSettings` from the `email/__init__.py` exports.

### `GmailAuth.scopes` is a configurable knob with one caller that never overrides it — `low`
`src/sentinel/email/gmail/auth.py:8`, `auth.py:25`, `auth.py:30`

`GmailAuth.__init__` accepts an optional `scopes` param defaulting to `DEFAULT_GMAIL_SCOPES`. The only constructor call (`gmail/client.py:50-54`) never passes it.

**Fix:** Drop the `scopes` parameter and use the scope constant directly, removing a constructor arg and the None-coalescing line. (Fold this into the OAuth consolidation below.)

### `time_utils.assume_local` / `_LOCAL_TZ` accommodates legacy timestamps the schema never produces — `low`
`src/sentinel/time_utils.py:7`, `time_utils.py:15-23`, `database.py:322-325`

`ensure_utc`/`parse_iso_datetime` carry an `assume_local` flag "for legacy app timestamps." The only `assume_local=True` caller is `_parse_datetime`, used solely on `telegram_link_token.expires_at` — a `TIMESTAMPTZ` column written via `utc_now()`, so psycopg always returns a tz-aware datetime and `_parse_datetime` returns at the early `isinstance` check. The legacy branch is unreachable.

**Fix:** Remove the `assume_local` parameter and `_LOCAL_TZ`; the other callers (`message.py:85,88`) use the default. `_parse_datetime`'s str-parsing fallback can likely be dropped entirely.

---

## 3. Duplication

### Two parallel Gmail OAuth implementations — `medium`
`src/sentinel/web/auth.py:40-69`, `email/gmail/auth.py:1-53`, `web/auth.py:37`, `gmail/auth.py:8`

Two near-parallel OAuth wrappers around `google-auth-oauthlib`. `web/auth.py` builds a client config and mints tokens via the web `Flow`; `GmailAuth` re-parses that same config and runs its own refresh. The `gmail.readonly` scope is declared twice (`GMAIL_SCOPES` vs `DEFAULT_GMAIL_SCOPES`). Worse, `GmailAuth.get_credentials()` contains a dead `InstalledAppFlow.run_local_server()` branch (auth.py:45-48) — tokens are *always* minted by the web flow, so in this headless worker that branch can only hang a thread, never succeed (see also next item).

**Fix:** Consolidate the scope constant into one module (drop `DEFAULT_GMAIL_SCOPES`, import `GMAIL_SCOPES`) and delete the `InstalledAppFlow`/`run_local_server` fallback. `GmailAuth` then collapses to load-token + refresh-if-expired — roughly half its size.

### `GmailAuth.get_credentials` interactive fallback in a headless worker — `low`
`src/sentinel/email/gmail/auth.py:44-48`

Same dead branch viewed as a robustness issue: if `token_json` is ever missing/unrefreshable, `get_credentials()` blocks on a local-server browser flow that cannot complete in the worker.

**Fix:** Replace the `run_local_server` fallback with a clear raised error (e.g. "Gmail not authorized; reconnect in the web console") so it fails fast. Removes the `InstalledAppFlow` import. (Same edit as above — do them together.)

### IMAP SSL connect + login + SELECT duplicated in client and probe — `low`
`src/sentinel/email/imap_client.py:32-65`, `web/imap_probe.py:29-42`, `imap_client.py:17`, `imap_probe.py:20`

Both perform `IMAP4_SSL(...) → login → select INBOX`, and each carries a near-identical comment about per-connection timeout. Note the two `_CONNECT_TIMEOUT_S` values differ (30 vs 15) and are plausibly intentional (background worker vs snappy interactive probe).

**Fix:** Extract a small shared `connect_imap(server, port, username, password, timeout)` helper and dedupe the comment. Keep the two timeout values distinct (pass them in) — do not collapse to a single constant.

### Identical email-header extraction defaults in both clients — `low`
`src/sentinel/email/imap_client.py:144-161`, `gmail/client.py:133-152`, `message.py:69-71`

Both clients apply byte-for-byte identical placeholder defaults (`"No Subject"`, `"Unknown Sender"`, etc.) before calling `build_message`, which then applies a *second*, inconsistent fallback layer (`"(no subject)"`, `"unknown sender"`) that is effectively dead because the clients always pass non-empty strings.

**Fix:** Drop the per-client placeholder defaults; pass the raw header value (or `""`/`None`) and let `build_message` own the single canonical fallback. Removes a dead fallback layer and 8 duplicated literals.

### `record_classified_message` / `record_failed_message` share transaction boilerplate — `low`
`src/sentinel/database.py:228-270`, `database.py:193-219`

The two methods are structurally identical (`lock` + `transaction` + `_insert_message` + None-check + one child INSERT); only the child INSERT differs.

**Fix:** Extract `_insert_message_with_child(message_fields, child_sql, child_params_fn)` owning the scaffolding. (Marginal — this is close to a matter of taste; lower priority than the other dedups.)

### Telegram base-URL constructed three ways — `low`
`src/sentinel/notify/telegram_message_notifier.py:85-105`, `telegram_bot.py:88-112`, `telegram_bot.py:155-163`

The `api.telegram.org/bot{token}/...` base URL is built inline three times; `telegram_bot.py` defines a `TELEGRAM_API` constant but the notifier hardcodes the full literal.

**Fix:** Share one `telegram_url(token, method)` helper / the `TELEGRAM_API` constant across both modules. Do **not** merge the two send paths into one `send_message()` — their return/error contracts differ intentionally (notifier returns message_id and distinguishes 5xx-retryable from 4xx; bot is fire-and-forget), and unifying them would add complexity.

---

## 4. Local code smells

### Per-stream cancel-and-await idiom repeated three times — `low`
`src/sentinel/monitor.py:78-88`, `monitor.py:153-163`, `monitor.py:251-261`

The `task.cancel(); try: await task except (asyncio.CancelledError, Exception): pass` block appears verbatim in `run()` teardown, `_stop_stream`, and `_cancel_all`. The `except (asyncio.CancelledError, Exception)` tuple is also misleading — it reads as if `CancelledError` needed special listing, when the intent is just "ignore everything during teardown."

**Fix:** Add one helper `async def _drain(task): task.cancel(); with contextlib.suppress(BaseException): await task` and call it from all three sites; `_cancel_all` becomes a loop over `self._stream_tasks.values()`. (Merges the two related findings on this idiom.)

### Redundant string fallback alongside enum comparison — `low`
`src/sentinel/web/app.py:345`, `email/mail_config.py:64-65`

`cfg.provider in (MailProvider.IMAP, "imap")` is doubly redundant: `use_enum_values = True` means `cfg.provider` is always the plain string `"imap"`, and since `MailProvider` is a str-Enum, `MailProvider.IMAP == "imap"` anyway.

**Fix:** Replace with `if cfg.provider == MailProvider.IMAP:` and drop the literal.

### IMAP body-decode fallback emits a bytes repr — `low`
`src/sentinel/email/imap_client.py:198-205`

The non-multipart `else` branch wraps `payload.decode("utf-8", errors="ignore")` in a try/except whose `body = str(payload)` fallback would feed a `b'...'` repr to the LLM. The except is unreachable (`decode(errors="ignore")` can't raise; `payload` is confirmed bytes), and the multipart branch has no such fallback — so the two paths are inconsistent.

**Fix:** Drop the try/except and the `str(payload)` fallback; `payload.decode("utf-8", errors="ignore")` cannot raise, matching the multipart branch.

---

## Recommended order of attack

1. **Delete the classification kill-switch chain** (`monitor.py` + `database.py`) — pure dead code, removes a public DB method and ~25 lines with zero behavior change.
2. **Drop the `inbox_type` column** end-to-end — removes a column, a parameter across ~5 methods, a tuple element, an always-true branch, and a silent-typo footgun.
3. **Remove the write-only `Message.metadata`** field/column and the `provider` plumbing that feeds it — shrinks `message.py`, both clients, the pipeline, and the DB.
4. **Consolidate Gmail OAuth**: delete the dead `run_local_server` fallback (replace with a fast error), unify the scope constant, and drop the unused `GmailAuth.scopes` param — halves `GmailAuth`.
5. **Sweep the small dead machinery**: `schema_meta` versioning, the empty `services/` dir + stale docstring, and `time_utils.assume_local`/`_LOCAL_TZ` — quick, no-risk deletions that tidy the foundations.