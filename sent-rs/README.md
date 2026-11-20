# Sent Rust rewrite — stage 1

This workspace is local-only. It does not change or start the existing TypeScript
applications. The sync worker and Solid frontend are not part of this stage.

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
```

The API defaults to port 3000. Configuration uses the names in `.env.example`;
`.env` is loaded without replacing exported variables. `WEB_DIST_PATH` can point
to any built SPA, with `index.html` fallback. Its default is the existing web
build, until the Solid application arrives. The server never starts a worker.
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
dispatch belongs to the later worker stage, not an inline HTTP request.

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
