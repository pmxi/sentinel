#!/bin/sh
set -eu

backup_dir=${SENT_BACKUP_DIR:-/opt/sent/backups}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_dir/sent-$timestamp.dump"

umask 077
mkdir -p "$backup_dir"
temporary=$(mktemp "$backup_dir/.sent-$timestamp.XXXXXXXX")
trap 'rm -f "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
"${NODE_BIN:-node}" --input-type=module - "$temporary" <<'JS'
import { spawnSync } from 'node:child_process';

try {
  const uri = /^(postgres(?:ql)?:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?$/.exec(process.env.DATABASE_URL);
  if (!uri) throw new Error();
  const [, scheme, authority, path, query = ''] = uri;
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const host = authority.replace(/^([^:@]*):([^@]*)@/, (_, user, password) => {
    env.PGPASSWORD = decodeURIComponent(password);
    return user + '@';
  });
  const params = query.split('&').filter((param) => {
    if (!param) return false;
    const separator = param.indexOf('=');
    const key = decodeURIComponent(separator < 0 ? param : param.slice(0, separator));
    if (key === 'password' || key === 'sslpassword') {
      if (separator < 0) throw new Error();
      env[key === 'password' ? 'PGPASSWORD' : 'PGSSLPASSWORD'] = decodeURIComponent(param.slice(separator + 1));
      return false;
    }
    return true;
  });
  const dbname = scheme + host + path + (params.length ? '?' + params.join('&') : '');
  const result = spawnSync('/usr/bin/pg_dump', [
    '--no-password', '--dbname=' + dbname, '--format=custom', '--compress=6', '--no-owner', '--no-acl',
    '--file=' + process.argv[2],
  ], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch {
  console.error('Cannot run pg_dump: check DATABASE_URL and the PostgreSQL client installation.');
  process.exitCode = 1;
}
JS
mv "$temporary" "$destination"
trap - EXIT HUP INT TERM
find "$backup_dir" -type f -name 'sent-*.dump' -mtime +14 -delete
printf 'Created %s\n' "$destination"
