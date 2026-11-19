#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=${SENT_DEPLOY_ROOT:-$HOME/sent}
REPO=${SENT_DEPLOY_REPO:-https://github.com/pmxi/sentinel.git}
API=${SENT_DEPLOY_CI_URL:-https://api.github.com/repos/pmxi/sentinel/commits}
ENV_FILE=${SENT_DEPLOY_ENV:-/opt/sent/app/.env}
LEGACY=${SENT_DEPLOY_LEGACY:-/opt/sent/app}
HEALTH=${SENT_DEPLOY_HEALTH:-http://127.0.0.1:3000/api/health}
export PATH="${SENT_DEPLOY_TOOLS:-$ROOT/tools/node}/bin:$PATH"
TIMEOUT=${SENT_DEPLOY_TIMEOUT:-240}
INTERVAL=${SENT_DEPLOY_INTERVAL:-5}
mkdir -p "$ROOT"/{releases,dumps,state,bin}
exec 9>"$ROOT/deploy.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
link() {
  ln -sfn "$1" "$2.next"
  mv -Tf "$2.next" "$2"
}
record() {
  printf '%s %s\n' "$sha" "$(date -u +%FT%TZ)" >"$ROOT/state/$1.tmp"
  mv "$ROOT/state/$1.tmp" "$ROOT/state/$1"
}
snapshot() { curl -fsS --max-time 10 "$HEALTH"; }
fresh=false
before=$(snapshot 2>/dev/null || printf '{}')
if printf '%s' "$before" | node -e '
let s=""; for await (const c of process.stdin) s+=c;
try { process.exit(JSON.parse(s).sync?.fresh === true ? 0 : 1); } catch { process.exit(1); }
'; then fresh=true; fi
healthy() {
  local deadline=$((SECONDS + TIMEOUT))
  while (( SECONDS <= deadline )); do
    if systemctl --user is-active --quiet sent-server.service &&
      systemctl --user is-active --quiet sent-worker.service &&
      snapshot 2>/dev/null | node -e '
let s=""; for await (const c of process.stdin) s+=c;
try {
 const h=JSON.parse(s), since=Number(process.argv[1]);
 process.exit(h.database === true && Date.parse(h.workerHeartbeat)>since &&
   (process.argv[2]!=="true" || Date.parse(h.sync?.oldestSuccessfulSyncAt)>since) ? 0 : 1);
} catch { process.exit(1); }
' "$started" "$fresh"; then return 0; fi
    sleep "$INTERVAL"
  done
  return 1
}
restart() {
  started=$(node -p 'Date.now()')
  systemctl --user restart sent-server.service sent-worker.service
}
previous=$(readlink -e "$ROOT/current" || true)
if [[ -z "$previous" ]]; then
  [[ -d "$LEGACY" ]] || { log "Missing legacy release: $LEGACY"; exit 1; }
  ln -sfn "$LEGACY" "$ROOT/releases/legacy-328f56f"
  previous="$ROOT/releases/legacy-328f56f"
  link "$previous" "$ROOT/current"
fi

mode=${1:-auto}
if [[ "$mode" == rollback ]]; then
  target=$(readlink -e "$ROOT/previous" || true)
  [[ -d "$target" ]] || { log 'No previous release'; exit 1; }
  log "Manual rollback to $target"
  link "$target" "$ROOT/current"
  if restart && healthy; then
    link "$previous" "$ROOT/previous"
    sha=$(basename "$target")
    record deployed
    log 'Rollback healthy (migrations not reversed)'
    exit 0
  fi
  log 'Manual rollback unhealthy; restoring original release'
  link "$previous" "$ROOT/current"
  if ! { restart && healthy; }; then log 'CRITICAL: original release unhealthy'; fi
  exit 1
elif [[ "$mode" == force && $# == 2 && "$2" =~ ^[0-9a-f]{40}$ ]]; then
  sha=$2
elif [[ "$mode" == auto && $# -le 1 ]]; then
  sha=$(git ls-remote "$REPO" refs/heads/master | cut -f1)
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log 'Cannot resolve master'; exit 1; }
  for state in deployed failed skipped; do
    if [[ -f "$ROOT/state/$state" ]] && read -r recorded _ <"$ROOT/state/$state" && [[ "$recorded" == "$sha" ]]; then exit 0; fi
    [[ ! -f "$ROOT/state/$state-$sha" ]] || exit 0
  done
  checks=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "$API/$sha/check-runs?per_page=100")
  verdict=$(printf '%s' "$checks" | node -e '
let s=""; for await (const c of process.stdin) s+=c;
const data=JSON.parse(s);
const checks=data.check_runs?.filter(c=>c.name==="check" && c.app?.slug==="github-actions") ?? [];
checks.sort((a,b)=>b.id-a.id);
const c=checks[0];
console.log(!c || data.total_count>100 || c.status!=="completed" ? "pending" : c.conclusion==="success" ? "success" : "skipped");
')
  case "$verdict" in
    pending) log "CI pending for $sha"; exit 0 ;;
    skipped) record "skipped-$sha"; record skipped; log "CI rejected $sha; skipped"; exit 0 ;;
    success) ;;
    *) log 'Invalid CI response'; exit 1 ;;
  esac
else
  log 'Usage: deploy.sh [auto | force <40-character-sha> | rollback]'
  exit 2
fi

failed() {
  trap - ERR INT TERM
  set +e
  log "Deploy $sha failed; restoring $previous (migrations not reversed)"
  record "failed-$sha"
  record failed
  link "$previous" "$ROOT/current"
  if restart && healthy; then log 'Previous release healthy'; else log 'CRITICAL: rollback health failed'; fi
  exit 1
}
trap failed ERR INT TERM
release="$ROOT/releases/$sha"
[[ "$(readlink -e "$ROOT/current")" != "$release" ]] || { log 'Requested release is already current'; exit 0; }
log "Building $sha"
if [[ ! -d "$ROOT/cache.git" ]]; then git clone --mirror "$REPO" "$ROOT/cache.git"; fi
git --git-dir="$ROOT/cache.git" fetch origin '+refs/heads/*:refs/heads/*'
git --git-dir="$ROOT/cache.git" cat-file -e "$sha^{commit}"
saved_previous=$(readlink -e "$ROOT/previous" || true)
if [[ "$release" != "$saved_previous" ]]; then
  if [[ -d "$release" ]]; then rm -rf -- "$release"; fi
  mkdir "$release"
  git --git-dir="$ROOT/cache.git" archive "$sha" | tar -x -C "$release"
  ln -s "$ENV_FILE" "$release/.env"
  (
    trap - ERR
    cd "$release"
    pnpm install --frozen-lockfile
    pnpm build
  )
fi
log 'Taking pre-migration database dump'
# libpq does not expand a URL in PGDATABASE, and argv is visible to other users, so pass it as PG* variables.
# shellcheck disable=SC2016
pg_values=$(node --env-file="$ENV_FILE" -e '
const u = new URL(process.env.DATABASE_URL);
const d = decodeURIComponent;
const values = new Map([["host", u.hostname], ["port", u.port], ["user", d(u.username)], ["password", d(u.password)], ["dbname", d(u.pathname.slice(1))]]);
for (const [k, v] of u.searchParams) values.set(k, v);
const names = {host:"PGHOST", hostaddr:"PGHOSTADDR", port:"PGPORT", user:"PGUSER", password:"PGPASSWORD", dbname:"PGDATABASE", sslmode:"PGSSLMODE", sslrootcert:"PGSSLROOTCERT", sslcert:"PGSSLCERT", sslkey:"PGSSLKEY", sslcrl:"PGSSLCRL", sslcrldir:"PGSSLCRLDIR", sslpassword:"PGSSLPASSWORD", ssl_min_protocol_version:"PGSSLMINPROTOCOLVERSION", ssl_max_protocol_version:"PGSSLMAXPROTOCOLVERSION", channel_binding:"PGCHANNELBINDING", connect_timeout:"PGCONNECT_TIMEOUT", application_name:"PGAPPNAME", options:"PGOPTIONS", target_session_attrs:"PGTARGETSESSIONATTRS", service:"PGSERVICE", passfile:"PGPASSFILE"};
for (const [k, v] of values) {
  if (!names[k] || /[\r\n\0]/.test(v)) throw new Error("Unsupported database connection option or value");
  console.log(names[k] + "=" + v);
}
')
mapfile -t pg_env <<<"$pg_values"
unset pg_values
dump="$ROOT/dumps/$(date -u +%Y%m%dT%H%M%S)-$sha.dump"
(
  trap - ERR
  export "${pg_env[@]}"
  pg_dump --format=custom --no-owner --no-acl --file="$dump.tmp"
)
mv "$dump.tmp" "$dump"
unset pg_env
mapfile -t dumps < <(find "$ROOT/dumps" -maxdepth 1 -name '*.dump' -printf '%f\n' | sort -r | tail -n +11)
for old in "${dumps[@]}"; do rm -- "$ROOT/dumps/$old"; done
log 'Applying migrations'
(trap - ERR; cd "$release" && pnpm --filter @sent/core db:migrate)
link "$previous" "$ROOT/previous"
link "$release" "$ROOT/current"
restart
healthy
log "Release $sha healthy"
install -m 700 "$release/deploy/deploy.sh" "$ROOT/bin/deploy.sh.next"
mv "$ROOT/bin/deploy.sh.next" "$ROOT/bin/deploy.sh"
record deployed
trap - ERR INT TERM
mapfile -t releases < <(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)
kept=0
for old in "${releases[@]}"; do
  kept=$((kept + 1))
  if (( kept > 5 )) && [[ "$ROOT/releases/$old" != "$release" && "$ROOT/releases/$old" != "$previous" ]]; then rm -rf -- "$ROOT/releases/$old"; fi
done
log "Deployed $sha"
