#!/bin/sh
set -eu
umask 077

database=${SENT_DATABASE_PATH:-./data/sent.sqlite}
backup_dir=${SENT_BACKUP_DIR:-./backups}
[ -f "$database" ] || { echo 'SQLite database does not exist.' >&2; exit 1; }
database=$(cd "$(dirname "$database")" && pwd)/$(basename "$database")
mkdir -p "$backup_dir"
cd "$backup_dir"
backup="sent-$(date -u +%Y%m%dT%H%M%S)-$$.sqlite"
temporary="$backup.tmp"
(set -C; : > "$temporary")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
sqlite3 -readonly "$database" ".backup $temporary"
ln "$temporary" "$backup"
find . -maxdepth 1 -type f -name 'sent-*.sqlite' -mtime +13 -delete
printf 'Created %s/%s\n' "$(pwd)" "$backup"
