#!/bin/sh
set -eu
umask 077

[ "$#" -eq 2 ] && [ -f "$1" ] || {
  echo 'Usage: scripts/restore.sh BACKUP.sqlite NEW_DATABASE_PATH' >&2
  echo 'Restore only to a new explicit path; stop services before installing it.' >&2
  exit 1
}
backup=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
target=$2
for path in "$target" "$target-wal" "$target-shm"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo 'Refusing to replace an existing database or sidecar.' >&2
    exit 1
  fi
done
mkdir -p "$(dirname "$target")"
directory=$(cd "$(dirname "$target")" && pwd)
target="$directory/$(basename "$target")"
cd "$directory"
temporary=".sent-restore-$$.sqlite"
(set -C; : > "$temporary")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
sqlite3 -readonly "$backup" ".backup $temporary"
[ "$(sqlite3 -readonly "$temporary" 'PRAGMA integrity_check;')" = ok ] || {
  echo 'Backup integrity check failed.' >&2
  exit 1
}
mv -n "$temporary" "$target"
[ ! -e "$temporary" ] || { echo 'Restore destination already exists.' >&2; exit 1; }
printf 'Restored SQLite backup to %s\n' "$target"
