#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=${SENT_DEPLOY_ROOT:-$HOME/sent}
REPO=${SENT_DEPLOY_REPO:-https://github.com/pmxi/sentinel.git}
API=${SENT_DEPLOY_CI_URL:-https://api.github.com/repos/pmxi/sentinel/commits}
ENV_FILE=${SENT_DEPLOY_ENV:-/opt/sent/app/.env}
HEALTH=${SENT_DEPLOY_HEALTH:-http://127.0.0.1:3000/api/health}
TOOLS=${SENT_DEPLOY_TOOLS:-$ROOT/tools}
export RUSTUP_HOME=${RUSTUP_HOME:-$TOOLS/rustup} CARGO_HOME=${CARGO_HOME:-$TOOLS/cargo}
export PATH="$TOOLS/node/bin:$CARGO_HOME/bin:$PATH"
CHECKS=${SENT_DEPLOY_CHECKS:-rust web}
UNITS=${SENT_DEPLOY_UNITS:-$HOME/.config/systemd/user}
TIMEOUT=${SENT_DEPLOY_TIMEOUT:-240}
INTERVAL=${SENT_DEPLOY_INTERVAL:-5}
mkdir -p "$ROOT"/{releases,dumps,state,bin,ci,data,backups}
database="$ROOT/data/sent.sqlite"
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
   (process.argv[2]!=="true" || !h.sync || !(h.sync.accounts>0) ||
     Date.parse(h.sync.oldestSuccessfulSyncAt)>since) ? 0 : 1);
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
[[ -x "$previous/bin/sent-server" && -x "$previous/bin/sent-worker" ]] || { log 'Missing current Rust release'; exit 1; }
[[ -f "$database" ]] || { log "Missing SQLite database: $database"; exit 1; }

mode=${1:-auto}
if [[ "$mode" == rollback ]]; then
  target=$(readlink -e "$ROOT/previous" || true)
  [[ -x "$target/bin/sent-server" && -x "$target/bin/sent-worker" ]] || { log 'No previous Rust release'; exit 1; }
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
    if [[ -f "$ROOT/state/$state" ]] && read -r recorded _ <"$ROOT/state/$state" && [[ "$recorded" == "$sha" ]]; then
      exit 0
    fi
    [[ ! -f "$ROOT/state/$state-$sha" ]] || exit 0
  done
  # Conditional requests that return 304 do not count against GitHub's 60/hour unauthenticated limit.
  ci="$ROOT/ci/$sha"
  find "$ROOT/ci" -maxdepth 1 -type f ! -name "$sha.*" -delete
  request=(-H 'Accept: application/vnd.github+json')
  if [[ -s "$ci.etag" && -s "$ci.json" ]]; then request+=(-H "If-None-Match: $(<"$ci.etag")"); fi
  code=$(curl -sS --max-time 20 "${request[@]}" -D "$ci.headers" -o "$ci.body" -w '%{http_code}' "$API/$sha/check-runs?per_page=100")
  case "$code" in
    200)
      mv "$ci.body" "$ci.json"
      tr -d '\r' <"$ci.headers" | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' | tail -1 >"$ci.etag"
      ;;
    304) rm -f "$ci.body" ;;
    *) log "CI query failed with HTTP $code"; exit 1 ;;
  esac
  verdict=$(node -e '
const data=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const verdicts=process.argv.slice(2).map(name=>{
  const runs=data.check_runs?.filter(c=>c.name===name && c.app?.slug==="github-actions") ?? [];
  runs.sort((a,b)=>b.id-a.id);
  const c=runs[0];
  return !c || data.total_count>100 || c.status!=="completed" ? "pending" : c.conclusion==="success" ? "success" : "skipped";
});
console.log(verdicts.includes("skipped") ? "skipped" : verdicts.includes("pending") ? "pending" : "success");
' "$ci.json" $CHECKS)
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

saved_previous=$(readlink -e "$ROOT/previous" || true)
failed() {
  trap - ERR INT TERM
  set +e
  log "Deploy $sha failed; restoring $previous (migrations not reversed)"
  record "failed-$sha"
  record failed
  link "$previous" "$ROOT/current"
  if [[ -n "$saved_previous" ]]; then
    link "$saved_previous" "$ROOT/previous"
  else
    rm -f "$ROOT/previous"
  fi
  if restart && healthy; then log 'Previous release healthy'; else log 'CRITICAL: rollback health failed'; fi
  exit 1
}
trap failed ERR INT TERM
release="$ROOT/releases/$sha"
[[ "$previous" != "$release" ]] || { log 'Requested release is already current'; exit 0; }
log "Building $sha"
if [[ ! -d "$ROOT/cache.git" ]]; then git clone --mirror "$REPO" "$ROOT/cache.git"; fi
git --git-dir="$ROOT/cache.git" fetch origin '+refs/heads/*:refs/heads/*'
git --git-dir="$ROOT/cache.git" cat-file -e "$sha^{commit}"
if [[ "$release" != "$saved_previous" ]]; then
  if [[ -d "$release" ]]; then rm -rf -- "$release"; fi
  mkdir "$release"
  git --git-dir="$ROOT/cache.git" archive "$sha" | tar -x -C "$release"
  ln -s "$ENV_FILE" "$release/.env"
  (
    trap - ERR
    cd "$release"
    cargo build --release --locked --target-dir "$ROOT/cargo-target" --bin sent-server --bin sent-worker
    mkdir -p bin
    cp "$ROOT/cargo-target/release/sent-server" "$ROOT/cargo-target/release/sent-worker" bin/
    pnpm --dir web install --frozen-lockfile
    NODE_ENV=production pnpm --dir web build
    [[ -f web/dist/index.html && -d migrations ]]
    printf 'WEB_DIST_PATH=%s\nMIGRATIONS_PATH=%s\nSENT_DATABASE_PATH=%s\n' "$release/web/dist" "$release/migrations" "$database" >runtime.env
  )
fi
for unit in sent-server.service sent-worker.service sent-deploy.service sent-deploy.timer sent-sqlite-backup.service sent-sqlite-backup.timer; do
  if [[ -f "$release/deploy/systemd/$unit" ]]; then install -D -m 644 "$release/deploy/systemd/$unit" "$UNITS/$unit"; fi
done
install -m 700 "$release/deploy/sent-run" "$ROOT/bin/sent-run.next"
mv "$ROOT/bin/sent-run.next" "$ROOT/bin/sent-run"
legacy_timer=$(systemctl show --property=LoadState --value sent-backup.timer)
legacy_service=$(systemctl show --property=LoadState --value sent-backup.service)
if [[ "$legacy_timer" != not-found || "$legacy_service" != not-found ]]; then
  if [[ "$legacy_timer" != not-found ]]; then sudo -n systemctl disable --now sent-backup.timer; fi
  if [[ "$legacy_service" != not-found ]]; then sudo -n systemctl stop sent-backup.service; fi
  sudo -n rm -f /etc/systemd/system/sent-backup.timer /etc/systemd/system/sent-backup.service
  sudo -n systemctl daemon-reload
fi
systemctl --user daemon-reload
log 'Taking pre-migration SQLite backup'
dump="$ROOT/dumps/$(date -u +%Y%m%dT%H%M%S)-$sha.sqlite"
sqlite3 "$database" ".backup '${dump//\'/\'\'}'"
mapfile -t dumps < <(find "$ROOT/dumps" -maxdepth 1 -name '*.sqlite' -printf '%f\n' | sort -r | tail -n +11)
for old in "${dumps[@]}"; do rm -- "$ROOT/dumps/$old"; done
# The Rust server applies pending migrations from runtime.env at startup, after this dump.
link "$previous" "$ROOT/previous"
link "$release" "$ROOT/current"
restart
healthy
install -m 700 "$release/deploy/sqlite-backup.sh" "$ROOT/bin/sqlite-backup.sh"
systemctl --user enable --now sent-sqlite-backup.timer
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
