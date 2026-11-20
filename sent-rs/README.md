# Sent Rust rewrite — stages 1–2

This workspace is local-only. It does not change or start the existing TypeScript
applications. The Solid frontend is not part of these stages.

## Local setup

From the repository root:

```sh
POSTGRES_PORT=5433 docker compose up -d postgres
export DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent
export SENT_FAKE_PROVIDERS=true
export SESSION_SECRET=sent-local-session-secret-at-least-32-characters
export SENT_PASSWORD_HASH="$(printf '%s' 'sent-local-dev-password' | pnpm -s sent:hash-password | tail -1)"
cargo build --release --manifest-path sent-rs/Cargo.toml
sent-rs/target/release/sent-seed --reset
sent-rs/target/release/sent-server
# In a second terminal with the same environment:
sent-rs/target/release/sent-worker
```

The API defaults to port 3000. Configuration uses the names in `.env.example`;
`.env` is loaded without replacing exported variables. `WEB_DIST_PATH` can point
to any built SPA, with `index.html` fallback. Its default is the existing web
build, until the Solid application arrives. The server never starts a worker;
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
