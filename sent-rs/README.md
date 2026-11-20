# Sent Rust/Solid rewrite

## On-device search

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

## One-command local benchmark

Prerequisites: a local default Docker context with Compose v2, Rust stable, Node 24, pnpm 11, Bash 4.3+
and curl. From the repository root (no `.env` setup required):

```sh
sent-rs/scripts/run-local.sh
# Optional: --messages 10000 --port 4001
# Or: SENT_LOCAL_DB=sent_benchmark_large SENT_LOCAL_PORT=4001 sent-rs/scripts/run-local.sh --messages 10000
```

The URL is **http://127.0.0.1:4000** and the local-only login password is
**`sent-local-dev-password`**. The runner prints both after the API, fake sync and
worker heartbeat are healthy. It starts only Compose's Postgres service on
loopback port **5433**, creates/uses **`sent_benchmark`** (never `sent`), installs
dependencies, builds Solid and the release binaries, applies the shared migrations
via the seeder, and replaces fake fixture accounts with a fresh deterministic
mailbox (3000 messages by default; `--messages 0` creates an empty mailbox).
Only names `sent_benchmark` or `sent_benchmark_*` are accepted as DB overrides.

The runner ignores `.env` for Compose and overrides DB/auth/provider settings for
the Rust processes: it binds to loopback, forces fake providers, disables AI/live
credentials, and uses disposable local auth/encryption values. Do not use these
values outside local development. No deployment services are started.

**Ctrl+C stops both Rust processes**; if either exits, the other is stopped too.
Postgres is deliberately left running, since other local databases may use it.
Run only one stack at a time against a given benchmark database; rerunning the
launcher resets the fake mailbox, so stop it before switching implementations.

### Compare today's TypeScript/React stack on the same seed

Run the launcher once and stop it with Ctrl+C. Do **not** reseed between captures
when comparing precisely the same mailbox state. From the repository root:

```sh
pnpm install --frozen-lockfile
NODE_ENV=production pnpm --filter @sent/web build
export DATABASE_URL=postgres://sent:sent-local-only@127.0.0.1:5433/sent_benchmark
export HOST=127.0.0.1 PORT=4000 NODE_ENV=development
export SENT_PUBLIC_URL=http://127.0.0.1:4000 SENT_WEB_URL=http://127.0.0.1:4000
export SESSION_SECRET=sent-local-only-benchmark-session-secret-not-for-production
export TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export SENT_PASSWORD_HASH="$(printf '%s' 'sent-local-dev-password' | pnpm -s sent:hash-password | tail -1)"
export OPENAI_API_KEY= GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= MICROSOFT_CLIENT_ID= MICROSOFT_CLIENT_SECRET=
export MICROSOFT_MAIL_SEND_ENABLED=false WEB_DIST_PATH="$PWD/apps/web/dist"
pnpm --filter @sent/server exec tsx src/index.ts
```

Use the same URL/password above (change DB/port consistently if overridden).
This runs the existing TS API and its built React UI against the shared seed,
without changing any TS code. **Do not run `pnpm dev` or the TS worker**: TS does
not implement `SENT_FAKE_PROVIDERS`, and fake credential markers intentionally
cannot authenticate. Browsing/search/drafts/undo work, but TS outbox delivery,
send completion and provider attachment downloads are not fake-provider capable.
For those benchmark actions use the TS server with the **Rust fake worker** in
a second terminal, exporting the same variables plus `SENT_FAKE_PROVIDERS=true`:

```sh
export DATABASE_URL=postgres://sent:sent-local-only@127.0.0.1:5433/sent_benchmark
export SENT_FAKE_PROVIDERS=true OPENAI_API_KEY=
sent-rs/target/release/sent-worker
```

The Rust fake worker never contacts providers; the TS API's provider attachment
download path still cannot serve fake bytes. Stop this worker before returning
to the all-Rust launcher. For read-only captures no worker is needed.

This workspace is local-only. It does not change or start the existing TypeScript
applications. The Solid frontend is a standalone package in `sent-rs/web`.

## Local setup

From the repository root:

```sh
POSTGRES_PORT=5433 docker compose up -d postgres
export DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent
export SENT_FAKE_PROVIDERS=true
export SESSION_SECRET=sent-local-session-secret-at-least-32-characters
export SENT_PASSWORD_HASH="$(printf '%s' 'sent-local-dev-password' | pnpm -s sent:hash-password | tail -1)"
cargo build --release --manifest-path sent-rs/Cargo.toml
pnpm --dir sent-rs/web install --frozen-lockfile
pnpm --dir sent-rs/web build
sent-rs/target/release/sent-seed --reset
sent-rs/target/release/sent-server
# In a second terminal with the same environment:
sent-rs/target/release/sent-worker
```

The API defaults to port 3000. Configuration uses the names in `.env.example`;
`.env` is loaded without replacing exported variables. `WEB_DIST_PATH` can point
to any built SPA, with `index.html` fallback. Its default is `sent-rs/web/dist`.
The server never starts a worker;
the worker is a separate process.
`MIGRATIONS_PATH` optionally selects a directory of SQL migrations.

The migration runner uses the original SQL files (not copies), advisory lock
89372411, and `sent_migrations(filename, applied_at)`, so the two stacks share one
schema and migration history. SQLx uses runtime queries; no database is needed to
build. The `v1` AES-256-GCM credential envelope is compatible with Node's format.

## Fixtures and provider safety

`sent-seed --messages N` defaults to 3000 messages in 1200 conversations, split
between Gmail and Microsoft fixture accounts. IDs, timestamps and contents are
deterministic. `--reset` deletes only the two deterministic fixture accounts and
their dependent data, not other accounts. Seeding requires both a loopback
database host and `SENT_FAKE_PROVIDERS=true`. It does not reset arbitrary databases.

Fake accounts contain an explicit `sent-fake-provider:` credentials marker, **not
real OAuth credentials**. The Rust provider boundary refuses to use that marker
for live requests even when fake mode is off. Existing TS providers also cannot
decrypt the marker, so they fail before making authenticated provider requests;
do not start the TS worker on the benchmark database. Fake mode returns local
attachment bytes and disables OAuth connections. Sending still enqueues exactly
the same durable mutation and removes the draft, as the TS API does; provider
dispatch is performed by the separate Rust worker, not an inline HTTP request.

## Checks

```sh
docker exec sent-postgres-1 psql -U sent -d sent -c 'create database sent_test_rust'
docker exec sent-postgres-1 psql -U sent -d sent -c 'create database sent_test_parity'
cd sent-rs
cargo build --release
cargo clippy -- -D warnings
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_rust cargo test
cd ..
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_parity sent-rs/scripts/parity.sh
pnpm check
```

Integration tests skip without `SENT_TEST_DATABASE_URL` and refuse database names
outside `sent_test_*`. They mutate/truncate their test database. Do not run TS and
Rust integration suites concurrently against the same test database.

The parity script starts **only** the two API servers, sequentially, resetting
the same local test database before each side. It compares response statuses and
JSON, every mailbox view through every cursor page, account filters, detail,
threads including trash, lexical search, drafts, actions and undo, tier overrides,
authentication boundaries, and login limits. Snapshots/logs are kept in ignored
`sent-rs/parity-logs/`. It normalizes generated draft/mutation IDs and draft
creation/update and undo-deadline timestamps only. Cursors are compared verbatim.

The TS error handler currently turns rate-limit errors into HTTP 500 with
`{"error":"Something went wrong"}`. The Rust server deliberately preserves this
observable result rather than silently changing it to 429/403.

## Remaining verification limits

Live OAuth, Microsoft MSAL cache interoperability, provider attachment downloads,
and OpenAI hybrid search have not been exercised against external services.
No production service or credentials are required by the local checks.

The validation port returns Zod-shaped errors for the original request schemas.
Parity includes invalid UUIDs, enum values, pagination limits, search filters,
tier/action bodies and draft addresses/lengths. It is not an exhaustive proof of
all JavaScript coercion edge cases or every malformed HTTP transport input.

## Rust worker

`sent-worker` replaces pg-boss with a Tokio scheduler: account discovery every
25 seconds (two syncs concurrently, one per account), backfill continuation after
5 seconds, outbox processing every 10 seconds, and heartbeat `main` every 30
seconds. Classification and embedding each have concurrency three and only get
queued for changed messages when backfill was already complete and an OpenAI key
is configured. Sync failures retry six times starting at 15 seconds; AI failures
retry five times starting at 30 seconds, both exponentially. Each sync attempt
expires after 30 minutes. Account status and classification failures are persisted.

Pending jobs and retry deadlines are checkpointed in the existing
`worker_state.metadata` JSON and restored on restart. A session advisory lock
89372413 enforces a single Rust scheduler per database. Do not run a TS worker
against that same mailbox concurrently. SIGINT/SIGTERM stop scheduling, drain
active work for up to 30 seconds, and checkpoint remaining work. Outbox delivery
continues to use the existing lease, retry and durable pre-send checkpoint: an
ambiguous dispatch or lost completion must not cause an automatic resend.

Fake mode never authenticates or calls either mail provider. Sync records success
and backfill completion without importing messages; local sends create an
outbound normalized message in the shared schema so it immediately appears in
Sent. Actions retain the API's optimistic changes and complete their outbox rows.
Completed rows are retained with status `complete`, exactly as in the TS outbox.

Provider, normalization, strict OpenAI response/link validation, attachment upload
and send-checkpoint tests use local wiremock HTTP servers, not real credentials.
`worker_outbox` additionally exercises delivery recovery using the isolated test
database. Run the reproducible server/worker smoke check on a fresh local DB:

```sh
docker exec sent-postgres-1 psql -U sent -d sent -c 'create database sent_test_worker'
cargo build --release --manifest-path sent-rs/Cargo.toml
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_worker python3 sent-rs/scripts/worker-smoke.py
```

The smoke check resets only fixture accounts, starts both Rust binaries, checks
healthy sync/heartbeat, waits for an undoable archive to complete, verifies a
draft send appears in Sent, and shuts down the worker via SIGTERM. Logs are in
the ignored `sent-rs/parity-logs/` directory. It needs Node and the existing TS
workspace's `pg` dependency solely to inspect the outbox rows.

## Solid frontend

`sent-rs/web` ports the React UI without changing `apps/web`. It uses Solid Router,
Solid Query with the same query keys, 15-second stale time, retry counts, 4-second
mail/thread polling while the local replica is unavailable, and mutation invalidations as React. Router preloading is
disabled; ordinary attachment links retain native browser navigation. Solid's
data reconciliation and keyed rows retain DOM identity across polling (the
equivalent of React's normal reconciliation, not another API cache). Triage
captures the visible order before Solid's synchronous updates hide a thread.

The package has its own pnpm workspace/lockfile so the existing TS application
workspace and its runtime dependencies are untouched. Its tests are the six
ported web test files, rendered with Solid in a browser-like DOM. Root Vitest
continues to run the original TS tests; run the Solid checks separately:

```sh
pnpm --dir sent-rs/web typecheck
pnpm --dir sent-rs/web lint
pnpm --dir sent-rs/web test
pnpm --dir sent-rs/web build
# Development: /api proxies to the Rust server on port 3000.
pnpm --dir sent-rs/web dev
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

### Browser mailbox replica

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
  detect hard-deleted records/accounts as well as tombstones. No PostgreSQL
  migration or shared TS schema change is needed.
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

After release/web builds, check against an isolated, existing local test database:

```sh
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_sqlite node sent-rs/web/scripts/replica-check.mjs
```

After the production web and Rust release builds, run the isolated Playwright
offline/update/auth check (it resets only the named local `sent_test_*` database):

```sh
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_sw pnpm --dir sent-rs/web sw:check
```

For the reproducible real-browser comparison, build both frontends and the Rust
binaries first. Start Chrome with CDP on `http://localhost:29229`, then run:

```sh
pnpm --filter @sent/web build
SENT_TEST_DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_test_solid pnpm --dir sent-rs/web browser:check
```

The browser check only accepts local `sent_test_*` databases. It creates the DB
if needed, resets fake accounts, starts the Rust server/worker in fake mode and
a React build preview, tests both logins, compares inbox/conversation copy,
and checks keyboard triage/undo, the palette, navigation, search, reply/forward,
draft autosave, attachments and send-to-Sent. Screenshots are saved outside the
repository at `~/screens/{react,solid}-{inbox,conversation}.png`; logs are saved
under `~/sent-stage3-*.log`. The processes and browser contexts it created are
closed afterward. No real provider credentials or external API calls are used.
