#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: scripts/restore.sh /path/to/sent.dump" >&2
  exit 1
fi

echo "This replaces the Sent database. Stop server and worker first."
printf "Type RESTORE to continue: "
read -r confirmation
[ "$confirmation" = "RESTORE" ] || exit 1
docker compose exec -T postgres dropdb -U sent --if-exists sent
docker compose exec -T postgres createdb -U sent sent
docker compose exec -T postgres pg_restore -U sent -d sent --clean --if-exists < "$1"
echo "Restore complete. Run: docker compose up -d"
