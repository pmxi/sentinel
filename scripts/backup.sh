#!/bin/sh
set -eu

backup_dir=${SENT_BACKUP_DIR:-./backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup_dir"
docker compose exec -T postgres pg_dump -U sent -d sent -Fc > "$backup_dir/sent-$timestamp.dump"
find "$backup_dir" -type f -name 'sent-*.dump' -mtime +14 -delete
echo "Created $backup_dir/sent-$timestamp.dump"
