#!/bin/sh
set -eu

usage() {
  echo "Usage: scripts/restore.sh [--scratch sent_restore_NAME] /path/to/sent.dump" >&2
  exit 1
}

if [ "${1:-}" = "--scratch" ]; then
  [ "$#" -eq 3 ] && [ -f "$3" ] || usage
  database=$2
  case "$database" in
    sent_restore_|*[!a-z0-9_]*) usage ;;
    sent_restore_*) [ "${#database}" -le 63 ] || usage ;;
    *) usage ;;
  esac
  pg_restore --no-password --dbname="$database" --single-transaction \
    --no-owner --no-privileges --no-comments < "$3"
  printf 'Restored to scratch database %s\n' "$database"
  exit 0
fi

[ "$#" -eq 1 ] && [ -f "$1" ] || usage

echo "This replaces the Sent database. Stop server and worker first."
printf "Type RESTORE to continue: "
read -r confirmation
[ "$confirmation" = "RESTORE" ] || exit 1
docker compose exec -T postgres dropdb -U sent --if-exists sent
docker compose exec -T postgres createdb -U sent sent
docker compose exec -T postgres pg_restore -U sent -d sent --single-transaction \
  --no-owner --no-privileges < "$1"
echo "Restore complete. Run: docker compose up -d"
