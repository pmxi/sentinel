#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MESSAGES=3000
PORT="${SENT_LOCAL_PORT:-4000}"
DB="${SENT_LOCAL_DB:-sent_benchmark}"
usage() {
  echo 'Usage: scripts/run-local.sh [--messages N] [--port PORT]'
  echo 'Defaults: 3000 messages, port 4000, SQLite database ./data/sent_benchmark.sqlite.'
  echo 'Overrides: SENT_LOCAL_PORT, SENT_LOCAL_DB (sent_benchmark or sent_benchmark_*).'
}
fail() { echo "Error: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --messages|--port)
      (($# >= 2)) || fail "$1 requires a value"
      if [[ "$1" == --messages ]]; then MESSAGES="$2"; else PORT="$2"; fi
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
done
[[ "$MESSAGES" =~ ^(0|[1-9][0-9]*)$ ]] || fail '--messages must be a nonnegative integer'
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && ((PORT <= 65535)) || fail '--port must be between 1 and 65535'
[[ "$DB" =~ ^sent_benchmark(_[a-z0-9_]+)?$ ]] && ((${#DB} <= 63)) || fail 'Database must be sent_benchmark or sent_benchmark_* (at most 63 characters)'
for tool in cargo node pnpm curl; do
  command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool"
done
cd "$ROOT"
export HOST=127.0.0.1 PORT NODE_ENV=development
export SENT_DATABASE_PATH="$ROOT/data/$DB.sqlite"
export SENT_PUBLIC_URL="http://127.0.0.1:$PORT" SENT_WEB_URL="http://127.0.0.1:$PORT"
export SENT_FAKE_PROVIDERS=true OPENAI_API_KEY= GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=
export MICROSOFT_CLIENT_ID= MICROSOFT_CLIENT_SECRET= MICROSOFT_MAIL_SEND_ENABLED=false
export SESSION_SECRET=sent-local-only-benchmark-session-secret-not-for-production
export TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export WEB_DIST_PATH="$ROOT/web/dist" MIGRATIONS_PATH="$ROOT/migrations"
export SENT_PASSWORD_HASH= SENT_DOMAIN=localhost
node --input-type=module - "$PORT" <<'NODE'
import net from 'node:net';
const server = net.createServer();
server.on('error', (error) => { console.error(`Cannot listen on benchmark port: ${error.message}`); process.exit(1); });
server.listen(Number(process.argv[2]), '127.0.0.1', () => server.close());
NODE
pnpm --dir "$ROOT/web" install --frozen-lockfile
NODE_ENV=production pnpm --dir "$ROOT/web" build
cargo build --release --locked --manifest-path "$ROOT/Cargo.toml" --target-dir "$ROOT/target"
export SENT_PASSWORD_HASH="$("$ROOT/target/release/sent-hash-password" sent-local-dev-password)"
"$ROOT/target/release/sent-seed" --reset --messages "$MESSAGES"

server_pid=
worker_pid=
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$server_pid" ]]; then kill -INT "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$worker_pid" ]]; then kill -TERM "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$worker_pid" ]]; then wait "$worker_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/target/release/sent-server" &
server_pid=$!
"$ROOT/target/release/sent-worker" &
worker_pid=$!
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$server_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null || fail 'Server or worker exited during startup'
  if node --input-type=module - "$SENT_PUBLIC_URL" <<'NODE'
try {
  const health = await (await fetch(`${process.argv[2]}/api/health`, {signal: AbortSignal.timeout(1000)})).json();
  if (health.status !== 'ok' || !health.sync.fresh || !health.workerHeartbeat) process.exit(1);
} catch { process.exit(1); }
NODE
  then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || fail 'Server/worker did not become healthy within 60 seconds'
echo "Benchmark URL: $SENT_PUBLIC_URL"
echo 'Local-only password: sent-local-dev-password'
echo "Database: $DB (fresh fake fixtures: $MESSAGES messages)"
echo 'Ctrl+C stops the Rust server and worker; the SQLite database is retained.'
wait -n "$server_pid" "$worker_pid"
fail 'Server or worker exited; stopping the other process'
