#!/bin/sh
set -eu

: "${PGSERVICE:?Set PGSERVICE to the libpq service for Sent}"
backup_dir=${SENT_BACKUP_DIR:-/opt/sent/backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_dir/sent-$timestamp.dump"

umask 077
mkdir -p "$backup_dir"
temporary=$(mktemp "$backup_dir/.sent-$timestamp.XXXXXXXX")
trap 'rm -f "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
/usr/bin/pg_dump --no-password --format=custom --compress=6 --no-owner --no-acl \
  --file="$temporary"
mv "$temporary" "$destination"
trap - EXIT HUP INT TERM
find "$backup_dir" -type f -name 'sent-*.dump' -mtime +14 -delete
printf 'Created %s\n' "$destination"
