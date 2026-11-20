#!/bin/sh
set -eu
umask 077

database=$(node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {parseEnv} from 'node:util';
let database = process.env.SENT_DATABASE_PATH;
if (database === undefined) {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    try {
      database = parseEnv(readFileSync(join(directory, '.env'), 'utf8')).SENT_DATABASE_PATH;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(directory) === directory) break;
  }
}
process.stdout.write(database ?? './data/sent.sqlite');
NODE
)
backup_dir=${SENT_BACKUP_DIR:-./backups}
[ -f "$database" ] || { echo 'SQLite database does not exist.' >&2; exit 1; }
database=$(realpath "$database")
mkdir -p "$backup_dir"
cd "$backup_dir"
backup="sent-script-backup-$(date -u +%Y%m%dT%H%M%S)-$$.sqlite"
temporary="$backup.tmp"
(set -C; : > "$temporary")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
sqlite3 -readonly "$database" ".backup $temporary"
ln "$temporary" "$backup"
find . -maxdepth 1 -type f -name 'sent-script-backup-*.sqlite' ! -samefile "$database" -mtime +13 -delete
printf 'Created %s/%s\n' "$(pwd)" "$backup"
