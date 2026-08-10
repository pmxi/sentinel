#!/bin/sh
set -eu

backup_dir=${SENT_BACKUP_DIR:-/opt/sent/backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_dir/sent-$timestamp.dump"
temporary="$backup_dir/.sent-$timestamp.dump.tmp"

umask 077
mkdir -p "$backup_dir"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
/usr/bin/pg_dump --dbname="$DATABASE_URL" --format=custom --compress=6 --no-owner --no-acl \
  --file="$temporary"
mv "$temporary" "$destination"
trap - EXIT HUP INT TERM
find "$backup_dir" -type f -name 'sent-*.dump' -mtime +14 -delete
printf 'Created %s\n' "$destination"
