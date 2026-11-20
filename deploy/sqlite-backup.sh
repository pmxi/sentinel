#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=${SENT_DEPLOY_ROOT:-$HOME/sent}
database="$ROOT/data/sent.sqlite"
[[ -f "$database" ]] || exit 0
mkdir -p "$ROOT/backups"
exec 9>"$ROOT/backups/.lock"
flock -n 9 || exit 0
backup="$ROOT/backups/$(date -u +%Y%m%dT%H%M%S).sqlite"
trap 'rm -f "$backup.tmp"' EXIT
sqlite3 "$database" ".backup '${backup//\'/\'\'}.tmp'"
mv "$backup.tmp" "$backup"
find "$ROOT/backups" -maxdepth 1 -type f -name '*.sqlite' -mtime +13 -delete
