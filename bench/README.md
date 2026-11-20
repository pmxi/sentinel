# Local SQLite browser benchmarks

Use only disposable local fake mail. Never point this harness at production.
The timed action requires a loopback URL and an absolute SQLite path whose
basename matches `sent_bench_*.sqlite`. Node 24+ is required for `node:sqlite`.

## Setup

Build the Rust workspace and `web/` using the root README. In `bench/`,
run `corepack pnpm install --frozen-lockfile`.

Set `SENT_DATABASE_PATH` to a fresh disposable `sent_bench_*.sqlite` file,
`SENT_FAKE_PROVIDERS=true`, and the local authentication variables documented in
the root README. Clear provider credentials and do not start a real worker.

From the repository root:

```sh
cargo run --release -p sent-seed -- --reset --messages 1
(cd bench && corepack pnpm seed --seed 1)
cargo run --release -p sent-server
```

The first command creates/migrates the database; the second replaces that tiny
fixture with 23,032 deterministic messages across 20,986 threads. Seed each arm
separately. The default seed command now uses SQLite; the older Postgres fixture
helpers remain only for historical comparisons.

## Run

From `bench/`, with the server running on loopback and the same database path:

```sh
corepack pnpm exec tsx src/run.ts --url http://127.0.0.1:3000 \
  --password sent-local-dev-password --actions new_mail_latency \
  --profiles local,lan,broadband --iterations 15 \
  --label incremental-live --out results/incremental-live
```

Results include individual samples, failures, warmup markers, network bytes and
request counts. Do not include warmups in medians/p95. Compare matching profiles,
fresh seeds, and the same browser/builds. The `inbox_load` and `warm_mailbox`
actions use the same timing primitives; alternate AB/BA when collecting controls.

`new_mail_latency` prepares a warm, caught-up replica before timing. Its clock
starts immediately before a direct SQLite INSERT transaction, and stops after
the exact new subject is painted (two animation frames). INSERT, classification,
and the live signal commit together. On the incremental server the signal is
named rows in `sent_live_changes`; on SQLite master it updates
`sent_live_signal`, the same durable signal used by its worker. Cleanup is
outside timing and uses the same signal path. All requests, including WebSocket
traffic, receive the selected profile's latency shaping.

Run `corepack pnpm test`, `corepack pnpm typecheck`, and `corepack pnpm lint`
from this directory to check the harness.
