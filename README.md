# Sent

Sent is a private, single-user web email client that unifies Gmail and Microsoft mail in one importance-tinted Inbox, and searches the complete synchronized archive by words and meaning.

The repository contains a SolidJS client (`web/`), a Rust Axum API (`server/`), a separate Rust Tokio worker (`worker/`), shared Rust code with the Gmail and Microsoft Graph adapters (`core/`), a fake-mail seeder (`seed/`), and SQLite SQL migrations (`migrations/`). The earlier TypeScript/React implementation is in git history before the Rust build replaced it. See [`plan.md`](./plan.md) for the product decisions and [`roadmap.md`](./roadmap.md) for intentionally deferred work.

## What works

- Gmail and Microsoft OAuth connection
- Full mailbox backfill followed by 30-second incremental polling
- Provider-native conversation IDs without cross-account thread merging
- Inbox, All Mail, Sent, Drafts, and Trash views
- Read/unread, flag, archive, delete, send, reply, reply all, and forward
- Sent-owned drafts and ordinary file attachments
- Versioned OpenAI classification, one-line inbox summaries, and clean reader text with Markdown hyperlinks and strict `{ reasoning, summary, tier, plainText }` output
- SQLite FTS5 (Porter stemming) plus sqlite-vec hybrid search, with lexical fallback if OpenAI is unavailable
- Manual tier overrides
- Password login, encrypted OAuth credentials, durable mutation outbox, retries, health checks, HTTPS, and backups

## Local development

### One-command local run

Prerequisites: Rust stable, a C compiler, Node 24, pnpm 11, Bash 4.3+
and curl. From the repository root (no `.env` setup required):

```sh
scripts/run-local.sh
# Optional: --messages 10000 --port 4001
# Or: SENT_LOCAL_DB=sent_benchmark_large SENT_LOCAL_PORT=4001 scripts/run-local.sh --messages 10000
```

The URL is **http://127.0.0.1:4000** and the local-only login password is
**`sent-local-dev-password`**. The runner prints both after the API, fake sync and
worker heartbeat are healthy. It creates/uses **`data/sent_benchmark.sqlite`**, installs
dependencies, builds Solid and the release binaries, applies the shared migrations
via the seeder, and replaces fake fixture accounts with a fresh deterministic
mailbox (3000 messages by default; `--messages 0` creates an empty mailbox).
Only names `sent_benchmark` or `sent_benchmark_*` are accepted as DB overrides.

The runner overrides DB/auth/provider settings for
the Rust processes: it binds to loopback, forces fake providers, disables AI/live
credentials, and uses disposable local auth/encryption values. Do not use these
values outside local development. No deployment services are started.

**Ctrl+C stops both Rust processes**; if either exits, the other is stopped too.
The SQLite file is retained under `data/`.
Rerunning the launcher resets the fake mailbox.

### Manual setup

From the repository root:

```sh
export SENT_DATABASE_PATH=./data/sent.sqlite
export SENT_FAKE_PROVIDERS=true
export SESSION_SECRET=sent-local-session-secret-at-least-32-characters
export SENT_PASSWORD_HASH="$(target/release/sent-hash-password sent-local-dev-password)"
cargo build --release
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
target/release/sent-seed --reset
target/release/sent-server
# In a second terminal with the same environment:
target/release/sent-worker
```

The API defaults to port 3000. Configuration uses the names in `.env.example`;
`.env` is loaded without replacing exported variables. `WEB_DIST_PATH` can point
to any built SPA, with `index.html` fallback. Its default is `web/dist`.
The server never starts a worker;
the worker is a separate process.
`MIGRATIONS_PATH` optionally selects a directory of SQL migrations.

The migration runner uses `BEGIN IMMEDIATE` and `sent_migrations(filename, applied_at)`.
The database file is created automatically, with WAL, foreign keys, a five-second busy timeout,
and FULL synchronous mode for durable sent-mail checkpoints.
SQLx uses runtime queries; no database is needed to
build. The `v1` AES-256-GCM credential envelope is compatible with Node's format.

### Fixtures and provider safety

`sent-seed --messages N` defaults to 3000 messages in 1200 conversations, split
between Gmail and Microsoft fixture accounts. IDs, timestamps and contents are
deterministic. `--reset` deletes only the two deterministic fixture accounts and
their dependent data, not other accounts. Seeding requires `SENT_FAKE_PROVIDERS=true`.
It does not reset arbitrary databases.

Fake accounts contain an explicit `sent-fake-provider:` credentials marker, **not
real OAuth credentials**. The Rust provider boundary refuses to use that marker
for live requests even when fake mode is off. Fake mode returns local
attachment bytes and disables OAuth connections. Sending still enqueues exactly
the same durable mutation and removes the draft; provider
dispatch is performed by the separate worker, not an inline HTTP request.

### Checks

CI (`.github/workflows/ci.yml`) runs the `rust` and `web` jobs on every push and PR;
production deploys wait for both. Locally:

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
bash -n scripts/run-local.sh && python3 scripts/test-run-local.py
python3 deploy/test-deploy.py
pnpm --dir web install --frozen-lockfile
pnpm --dir web typecheck && pnpm --dir web lint && pnpm --dir web test && pnpm --dir web build
```

Database integration tests run unconditionally, using a fresh temporary SQLite file per test.

Live OAuth, provider attachment downloads and OpenAI hybrid search are not exercised
by these checks; no production service or credentials are required.

### Worker

`sent-worker` is a Tokio scheduler: account discovery every
25 seconds (two syncs concurrently, one per account), backfill continuation after
5 seconds, outbox processing every 10 seconds, and heartbeat `main` every 30
seconds. Classification and embedding each have concurrency three and only get
queued for changed messages when backfill was already complete and an OpenAI key
is configured. Sync failures retry six times starting at 15 seconds; AI failures
retry five times starting at 30 seconds, both exponentially. Each sync attempt
expires after 30 minutes. Account status and classification failures are persisted.

Pending jobs and retry deadlines are checkpointed in the existing
`worker_state.metadata` JSON and restored on restart. An exclusive file lock on
`<database path>.worker.lock` enforces a single scheduler per database. SIGINT/SIGTERM stop scheduling, drain
active work for up to 30 seconds, and checkpoint remaining work. Outbox delivery
continues to use the existing lease, retry and durable pre-send checkpoint: an
ambiguous dispatch or lost completion must not cause an automatic resend.

Fake mode never authenticates or calls either mail provider. Sync records success
and backfill completion without importing messages; local sends create an
outbound normalized message in the shared schema so it immediately appears in
Sent. Actions retain the API's optimistic changes and complete their outbox rows.
Completed rows are retained with status `complete`.

Provider, normalization, strict OpenAI response/link validation, attachment upload
and send-checkpoint tests use local wiremock HTTP servers, not real credentials.
`worker_outbox` additionally exercises delivery recovery using the isolated test
database. Run the reproducible server/worker smoke check on a fresh local DB:

```sh
cargo build --release
python3 scripts/worker-smoke.py
```

The smoke check resets only fixture accounts, starts both Rust binaries, checks
healthy sync/heartbeat, waits for an undoable archive to complete, verifies a
draft send appears in Sent, and shuts down the worker via SIGTERM. Logs are in
the ignored `parity-logs/` directory. It uses Python's sqlite3 module to inspect
outbox rows in its own temporary database.

### Web client

`web` uses Solid Router, Solid Query with 15-second stale time, retry counts, 4-second
mail/thread polling while the local replica is unavailable, and mutation invalidations. Router preloading is
disabled; ordinary attachment links retain native browser navigation. Solid's
data reconciliation and keyed rows retain DOM identity across polling. Triage
captures the visible order before Solid's synchronous updates hide a thread.

It is its own pnpm package with its own lockfile:

```sh
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web build
# Development: /api proxies to the Rust server on port 3000.
pnpm --dir web dev
```

Production builds include a hand-written service worker (HTTPS or localhost only).
It verifies and precaches `index.html` and hashed assets, serves only this static
shell cache-first, and never intercepts `/api/*`. Build-content hashes version the
cache; activation deletes older shell caches and claims clients. Controlled tabs
reload once when a new worker activates, unless a composer is open. Updates flush
pending draft text and wait until the composer closes, retaining in-memory
attachments; failed saves leave it open for retry. Startup and returning to a visible tab
check for updates with the worker HTTP cache bypassed. HTML network responses
remain `no-cache`; `sw.js` is `no-store` and ignores conditional validators so
even equal-sized builds published within one filesystem timestamp activate.

`localStorage` holds a last-verified-session marker, account metadata and an opaque replica session ID, not
mail or credentials. It can paint the shell before fresh API responses arrive,
including offline. Every startup revalidates the session; an API 401, logout, or
another tab clearing this metadata returns to login and clears private query data.

#### Browser mailbox replica

After first paint, a dedicated worker loads the official `@sqlite.org/sqlite-wasm`
and opens a schema-versioned SQLite database through the OPFS SAH-pool VFS. This
VFS does not require cross-origin isolation headers. The database belongs to one
login and survives document reloads; another tab unable to acquire its OPFS lock
uses an in-memory database. Unavailable OPFS or persistent session storage also
uses memory; unavailable or failed workers retain the network query path.
Initialization starts after two seconds and never gates rendering or login.

The first snapshot downloads in the background. Until it is complete, queries
continue using the existing API. Once ready, every mailbox view, cursor page,
message and conversation reads SQLite first. One delta request every four seconds
replaces mailbox/reader polling. Optimistic changes are journaled locally as well
as sent through existing mutations; failed writes and undo restore local state
without discarding newer overlapping actions. There is no offline mutation queue.
Search remains server-side until the separate search step.

New authenticated endpoints, without changing existing endpoint JSON:

- `GET /api/sync/snapshot?limit=2000&cursor=...`: immutable paged headers, account
  data and detail/thread metadata for all mailbox views, including archived/trash.
- `GET /api/sync/delta?cursor=...`: upserts and deleted IDs from a consistent
  inventory. Repeatable-read snapshots plus content fingerprints avoid missed
  commits from timestamp ordering, catch classification/outbox-only changes and
  detect hard-deleted records/accounts as well as tombstones.
- `GET /api/sync/bodies?ids=...`: background recent-body and on-open older-body reads, at most 16
  messages and 256 KiB of combined body text per message. Oversized bodies use the
  existing network reader without persistence. Cached bodies are versioned and
  retained for the recent window; older, opened bodies use a 32 MiB LRU budget.

Every message's row stays local regardless of age. `RECENT_BODY_DAYS` in
`web/src/replica-policy.ts` is the single 90-day cutoff setting. Eligible full
bodies sync in low-priority background batches after the row snapshot is ready.
Older bodies are fetched only on open, then cached. Recent-body prefetch never
downloads an older conversation member speculatively. Unopened background bodies
expire when they age out; explicitly opened bodies can remain in the older LRU.
Attachments (file contents) and embeddings are never stored in SQLite. Attachment
metadata/counts remain available for the existing UI. The original per-message
256 KiB body limit still applies; larger messages retain the network reader path.

Replica schema version 3 stores compact metadata tuples and shares account records.
Lists scan a chronological filter/order index with an early limit, then batch thread
counts and senders through a second covering index. Only conversation-summary
columns cross the worker boundary. Snapshot commit vacuums discarded staging and
obsolete schema pages before advertising readiness. Full bodies retain all reader
forms losslessly: the worker gzip-compresses them with `CompressionStream` when
smaller and restores them before publishing reader data. Equal text/plain forms
share one stored value; browsers without compression keep ordinary JSON bodies.
The older-body LRU continues charging uncompressed bytes.

Tradeoff: each delta scans the current header inventory on the server; it is not
an indexed, durable event log. The server retains 16 bounded cursor generations,
including at most two full snapshots, with a 15-minute idle lifetime. Restart or
eviction returns `410 { reset: true }` and triggers a background resnapshot, never
a silently skipped update. Snapshot and delta payloads contain no message bodies.

Mail is stored in the browser's private OPFS storage, not encrypted by this
application. Logout/401 revokes the local session, closes/wipes its database and
notifies other tabs. LocalStorage contains no mail, passwords or bearer tokens.
Pending shell activation waits for these private database wipes before reloading.
Sign-out waits up to two seconds before navigating; unfinished cleanup keeps a
durable revoked identifier. Startup retries orphaned/revoked database deletion
before opening a replica. Query connectivity gating never blocks SQLite reads,
and incomplete body placeholders cannot be quoted into reply/forward drafts.
Pending-body readers refetch on reconnect even while their cached headers are fresh.
The static-only service worker still never handles `/api/*`.

Use the Rust database tests to verify the server's SQLite setup.

#### On-device search

Schema 6 rebuilds the browser cache once and maintains one contentless-delete FTS5
index over subject/sender/recipients/snippet headers and locally cached body text.
Only message/thread IDs and ordering timestamps are retained as unindexed content;
searchable text is not stored twice. BM25 favors subject and sender matches,
with recency/ID tie-breaks; the final literal token is a prefix. Operators, quotes and
punctuation in user queries cannot become FTS syntax. Indexed text and queries share
NFKC normalization. Queries are bounded to 32 tokens.

The search page and Cmd+K share the existing debounced query cache. Once the replica
is ready they publish a viewport-sized local lexical page without a request, then
append the rest of the 75-result page after paint. Native FTS rank limits candidates;
ties and duplicate conversations expand the bound before recency/ID tie-breaking.
Background initialization warms the search index into SQLite's 64 MiB target page
cache; this uses RAM, not another persistent copy or a search-result cache. When
recent-body initialization completes, it reads the FTS payload pages and runs one
representative header query to warm the SQLite/WASM search path before user input.
Online hybrid search
refines asynchronously after that paint; existing rows and selected message identities
stay fixed while semantic-only conversations append. Offline no refinement is sent.
Embeddings and attachment contents remain server-side. Mail older than 90 days whose
body has not been opened locally is searchable by headers/snippet, **not its body**.
Body arrival, eviction, version changes, snapshots, deltas and tombstones update the
index; archived mail stays searchable, deleted mail does not.

## Required external credentials

Sent starts without provider or OpenAI credentials, but connecting accounts and AI features require these values in `.env`.

### OpenAI

- `OPENAI_API_KEY`
- The defaults are `gpt-5.6-luna` with xhigh reasoning for classification and `text-embedding-3-large` for search.
- Email headers and the complete normalized body are sent for classification. Very large bodies are trimmed only for the smaller embedding context.

### Google

Create a Web application OAuth client in a Google Cloud project with the Gmail API enabled.

- Authorized redirect URI: `${SENT_PUBLIC_URL}/api/oauth/gmail/callback`
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Sent requests `gmail.modify`, `gmail.send`, `openid`, `email`, and `profile` scopes.
- If the consent screen is in testing mode, add the Gmail address as a test user.

### Microsoft / Purdue

Register a confidential web application in Microsoft Entra ID.

- Redirect URI: `${SENT_PUBLIC_URL}/api/oauth/microsoft/callback`
- Delegated Microsoft Graph permission: `Mail.ReadWrite`
- Enable `openid`, `profile`, and `offline_access` through the authorization request.
- Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
- Keep `MICROSOFT_TENANT_ID=common`, or use Purdue's tenant ID if its policy requires a single-tenant app.
- Sending from Microsoft additionally requires delegated `Mail.Send`; set
  `MICROSOFT_MAIL_SEND_ENABLED=true` only after Purdue approves it.
- Purdue may require an administrator to approve the app or its delegated mail permissions.

Sent discovers the Microsoft folder tree and keeps one delta cursor per folder; Gmail uses mailbox history IDs. Native folders and labels are retained internally but are not exposed as organization controls in the MVP.

Mailbox views show one row per conversation within each account, using the latest message eligible for that view. The default Inbox at `/inbox` contains all unarchived inbound mail, including unsorted messages. Importance tints distinguish tiers without separate folders; reader tier corrections remain available. All Mail includes archived and sent messages, and outgoing messages appear in Sent. Microsoft Sent Items is identified by its well-known folder ID, so sending aliases and localized folder names do not break this separation. Legacy L1/L2/L3 API views remain supported, while their old browser routes redirect to Inbox.

Before submitting a message, the outbox records a durable send attempt. Failures before submission can retry automatically; an uncertain delivery or failure to save the successful result cannot trigger another send. Such attempts are flagged for reconciliation. Microsoft messages are imported into Sent immediately after successful sending when available, with normal polling as a fallback.

Sent supports up to 10 outgoing attachments totaling 20 MB per message. Microsoft files of 3 MB or larger use chunked upload sessions; smaller files are attached individually. This applies to new messages, replies, and forwards and uses the existing `Mail.ReadWrite` and `Mail.Send` permissions. The mailbox provider may impose additional message-size limits.

## First import

After connecting each account in Settings, the worker pages through the entire archive. Unclassified mail remains visible without importance tint in Inbox and All Mail, so an AI failure cannot hide mail. The worker classifies, generates reader text, and embeds newly synchronized messages once `OPENAI_API_KEY` is configured. The manual historical classify/embed commands belonged to the TypeScript build and have not been ported yet.

## Production deployment

The application uses `SENT_DATABASE_PATH`, default `./data/sent.sqlite`.
Only SQLite-backed Rust releases are supported for deployment and binary rollback.

### Native production: pull-based push-to-deploy

The production box runs user systemd units as `sentinel` (linger must already
be enabled). Every 30 seconds `sent-deploy.timer` checks GitHub's `master` SHA.
Only a new SHA queries the GitHub check-runs API (with ETags, so unchanged answers are free);
the latest GitHub Actions `rust` and `web` jobs must succeed. Pending checks retry next tick; rejected checks and
failed deploys are remembered so they do not loop. No inbound webhook is needed.

Releases are built from a cached mirror into `~/sent/releases/<sha>`: the Rust
`sent-server` and `sent-worker` binaries (`cargo build --release --locked`, shared
`~/sent/cargo-target` for incremental builds) are copied to the release's `bin/`, and the
Solid app is built with pnpm. The release's `runtime.env` points `WEB_DIST_PATH` and
`MIGRATIONS_PATH` at that release. The shared `/opt/sent/app/.env` is symlinked, never
copied. Each release installs its systemd units and `~/sent/bin/sent-run`, which starts
the Rust binaries. Every release exports
`SENT_DATABASE_PATH=~/sent/data/sent.sqlite` through its `runtime.env`.
Deployments require an existing current Rust release and SQLite database.
Before switching releases, a consistent `sqlite3 .backup` is taken; the latest ten
deployment backups are retained. Then `~/sent/current` switches atomically and
both units restart; the Rust services apply pending migrations at startup, after
the backup. Health requires active units, database connectivity and a worker
heartbeat after restart, not `status: "ok"`. If sync was fresh before deployment,
its oldest successful sync must also be after restart.
Health has a four-minute budget. Failure restores and checks the previous
release; backups are not automatically restored. Successful releases install
their own deploy script and retain about five releases, protecting current
and previous. Manual rollback supports previous Rust releases only.

Update the deployer on an existing SQLite production installation, as `sentinel`,
from a checkout of this repository:

```sh
mkdir -p ~/sent/{bin,tools,releases,dumps,state} ~/.config/systemd/user
# Unpack a trusted Node 24 linux-arm64 tarball to ~/sent/tools/node first, and install
# stable Rust with rustup using RUSTUP_HOME=~/sent/tools/rustup CARGO_HOME=~/sent/tools/cargo.
# That installation must include corepack. Node is used for builds and deploy health/CI JSON.
export PATH="$HOME/sent/tools/node/bin:$PATH"
corepack enable
corepack prepare pnpm@11.21.0 --activate
# Also required on PATH: git, curl, flock, tar, sqlite3.
# git ls-remote https://github.com/pmxi/sentinel.git must work non-interactively.
install -m 700 deploy/deploy.sh ~/sent/bin/deploy.sh
install -m 700 deploy/sent-run ~/sent/bin/sent-run
install -m 644 deploy/systemd/sent-{server,worker,deploy}.service deploy/systemd/sent-deploy.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable sent-server.service sent-worker.service
systemctl --user enable --now sent-deploy.timer
systemctl --user start sent-deploy.service
```

Keep the shared `/opt/sent/app/.env` readable only by its owner. The user services
keep that EnvironmentFile path; it no longer needs any legacy database variables.
Every release installs its units and launcher before restarting.

When the old system-level `sent-backup.timer` or `sent-backup.service` is present,
deploy logs a warning with this one-time administrator cleanup command and
continues without privileges. The deploy service retains `NoNewPrivileges=true`.
The user-level SQLite backup timer is unaffected.

```sh
sudo systemctl disable --now sent-backup.timer && sudo systemctl stop sent-backup.service && sudo rm -f /etc/systemd/system/sent-backup.timer /etc/systemd/system/sent-backup.service && sudo systemctl daemon-reload
```

```sh
journalctl --user -u sent-deploy -u sent-server -u sent-worker -f
systemctl --user status sent-deploy.timer
cat ~/sent/state/{deployed,failed,skipped} 2>/dev/null
readlink -f ~/sent/{current,previous}
# Stop automatic updates while investigating or intentionally pinning a rollback:
systemctl --user stop sent-deploy.timer
~/sent/bin/deploy.sh rollback
# Explicit retry / operator override: bypasses CI and failed/skipped records.
~/sent/bin/deploy.sh force <full-40-character-commit-sha>
systemctl --user start sent-deploy.timer
```

Manual commands share the timer's lock. Failures exit nonzero and log rollback
health separately. `state/failed-<sha>` and `state/skipped-<sha>` preserve history;
`state/deployed` contains the current successful SHA and UTC time. The unauthenticated
GitHub API has a shared 60-request/hour limit; API/network errors fail closed and
retry next tick. A missing check (or more than 100 check runs) stays pending.
**Migrations must remain backward-compatible with the previous release: rollback
does not undo migrations.** Copy dumps off-host and test restores separately.

For isolated local deployment tests, run `python3 deploy/test-deploy.py`.
Paths/endpoints can be overridden with `SENT_DEPLOY_ROOT`, `SENT_DEPLOY_REPO`,
`SENT_DEPLOY_CI_URL` (commits API prefix), `SENT_DEPLOY_ENV`,
`SENT_DEPLOY_TOOLS`, and `SENT_DEPLOY_HEALTH`;
`SENT_DEPLOY_TIMEOUT` and `SENT_DEPLOY_INTERVAL` control health polling seconds.

## Backups

SQLite releases install and enable the user-level `sent-sqlite-backup.timer`.
It runs nightly at 03:30 with up to 30 minutes jitter, uses SQLite's consistent
backup API through `sqlite3 .backup`, and retains 14 days in `~/sent/backups`
with private permissions. Run `systemctl --user start sent-sqlite-backup.service`
to test it. Copy backups off-host. To restore, stop both services, preserve the
current database and its `-wal`/`-shm` sidecars, then install a backup as
`~/sent/data/sent.sqlite`, run the integrity checks below, and restart.
Never copy a live SQLite database without using the backup API.

For local SQLite installations, `scripts/backup.sh` also uses the consistent
SQLite backup API. It resolves `SENT_DATABASE_PATH` from the environment first,
then the nearest `.env` in the current directory or its parents, then defaults
to `./data/sent.sqlite`. A missing configured database is an error, not a reason
to fall back. Set `SENT_BACKUP_DIR` to override `./backups`; backups are private and retained for
14 days. Retention applies only to its `sent-script-backup-*.sqlite` files,
never the source database. Both scripts use `sent-server --print-database-path`,
which runs the app's exact configuration loader (including first-wins duplicate
assignments and variable expansion), without starting services or opening the
database. A built `sent-server` on PATH and the `sqlite3` command-line tool are
required. Override the executable with `SENT_SERVER_BIN`, for example
`SENT_SERVER_BIN=./target/release/sent-server scripts/backup.sh`. No Compose database
service is used.

Restore to a **new explicit path**; the script refuses existing targets or
sidecars and the configured application database path, even if missing:

```sh
scripts/restore.sh /path/to/sent-backup.sqlite ./restore-check/sent.sqlite
sqlite3 ./restore-check/sent.sqlite 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

The integrity check must print `ok` and the foreign-key check must return no rows.
Stop both services before installing the restored file at the configured database
path. Preserve the old database and its sidecars together. Never replace a live
database, and never reuse sidecars from the old file.

## Common commands

```sh
scripts/run-local.sh                        # fake-mail local stack on http://127.0.0.1:4000
cargo build --release                       # sent-server, sent-worker, sent-seed, sent-hash-password
target/release/sent-hash-password 'pass'    # generate an Argon2id login hash
pnpm --dir web build                        # production web build in web/dist
```

The server and worker apply pending SQL migrations from `migrations/` at startup.

## Security notes

- The login has no signup or recovery path. It is intentionally one deployment-configured owner password.
- OAuth token caches are encrypted with AES-256-GCM before storage.
- Message bodies, access tokens, model payloads, and sign-in codes are not written to ordinary logs.
- HTML email is sanitized and rendered in a sandboxed iframe. Remote images load normally for now; proxying them is on the roadmap.
- Generated reader text supports basic Markdown, including descriptive hyperlinks. Raw HTML, images, and unsafe link schemes are disabled in this view; the original email is always available.
- The model selects short link references; Sent inserts the original URL definitions afterward so long signed links are not recopied by the model.
- The mutation outbox first records an action in SQLite, updates Sent optimistically, and then retries the provider write until it succeeds or surfaces as failed.

## Live mailbox updates

`/api/live` is a same-origin, session-cookie-authenticated WebSocket. Set
`SENT_PUBLIC_URL` to the exact public origin, including the scheme and any
non-default port. Requests without that Origin or a valid cookie are rejected;
HTTP bearer tokens alone cannot open a socket. Logout closes the session's
sockets, including other tabs, and expiry closes them without waiting for a
subsequent API request. Logout revocations are kept in memory until JWT expiry
and shared through an expiry-pruned SQLite revocation table. Only opaque session
keys and expiry times are stored, not cookies or credentials.

Rust ingest/sync, classification, outbox results and API writes record incremental
changes in `sent_live_changes` within their mutation transactions. Account changes
can request a full inventory through `live::notify_changed`. Each server holds a dedicated SQLite
connection and polls `PRAGMA data_version` every 150 ms, so commits by the separate
worker process also wake connected clients. Rolled-back transactions do not
signal. The server reconnects on database errors, coalesces bursts for
50 ms and reads a committed inventory once per batch. It fans out a shared-cursor
delta when it fits (32 upserts, 512 removals and 64 KiB), otherwise a cursor hint.
The replayable HTTP delta feed remains authoritative: a cursor mismatch or
expired generation causes catch-up or a background resnapshot, not skipped rows.

Repeated inventories memoize the existing body SHA-256 using transactionally
maintained per-message revision tokens. Triggers invalidate them on message or
classification changes, including direct SQL edits and classification deletion.
The cache contains at
most 65,536 digests per process, not body text. Body hashes and HTTP JSON remain
unchanged; even SQL edits that omit `updated_at` invalidate a cached digest.
Database reconnect clears the memo, and inventories publish in database-read order.
The first inventory after a cold start/reconnect still hashes the full body corpus.

Push and polling are serialized before applying SQLite/cache updates. While the
socket is healthy, safety polling runs every 60 seconds; a blocked, unavailable
or silent socket restores four-second polling without an application error.
Reconnect uses jittered exponential backoff, and online/visible transitions
catch up immediately. Network-only clients invalidate queries on push too.
Both paths respect pending optimistic writes. Heartbeats run every 20 seconds
with a 45-second idle deadline. The server caps connections at eight per session
and 128 total, incoming frames at 16 KiB/32 messages per second, and write buffers
at 128 KiB. Sends time out after five seconds; latest-only notification queues
bound slow-client backpressure. Losing the database poller closes sockets so clients poll
until the single connection recovers.

For nginx, forward the upgrade explicitly (the ordinary HTTP location can stay
unchanged):

```nginx
location = /api/live {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
}
```

Use the external HTTPS origin for `SENT_PUBLIC_URL` when nginx terminates TLS.
If Upgrade is not forwarded, the UI keeps using four-second HTTP delta polling.
