# Sent

Sent is a private, single-user web email client that unifies Gmail and Microsoft mail, puts important messages in an L1 attention queue, and searches the complete synchronized archive by words and meaning.

The repository contains a responsive React client, a Fastify API, a separate PostgreSQL-backed worker, Gmail and Microsoft Graph adapters, and a PostgreSQL/pgvector database. See [`plan.md`](./plan.md) for the product decisions and [`roadmap.md`](./roadmap.md) for intentionally deferred work.

## What works

- Gmail and Microsoft OAuth connection
- Full mailbox backfill followed by 30-second incremental polling
- Provider-native conversation IDs without cross-account thread merging
- L1/L2/L3, Unclassified, All Mail, Sent, Drafts, and Trash views
- Read/unread, flag, archive, delete, send, reply, reply all, and forward
- Sent-owned drafts and ordinary file attachments
- Versioned OpenAI classification and clean reader text with Markdown hyperlinks and strict `{ reasoning, tier, plainText }` output
- PostgreSQL full-text plus pgvector hybrid search, with lexical fallback if OpenAI is unavailable
- Manual tier overrides
- Password login, encrypted OAuth credentials, durable mutation outbox, retries, health checks, HTTPS, and backups

## Local development

Requirements: Node.js 24+, pnpm through Corepack, and Docker.

1. Install dependencies.

   ```sh
   corepack pnpm install
   ```

2. Start PostgreSQL only.

   ```sh
   docker compose up -d postgres
   ```

   If port 5432 is already occupied, run this with `POSTGRES_PORT=5433` and use port 5433 in the local `DATABASE_URL` below.

3. Copy `.env.example` to `.env`, then set these local values:

   ```sh
   SENT_PUBLIC_URL=http://localhost:3000
   SENT_WEB_URL=http://localhost:5173
   DATABASE_URL=postgres://sent:sent-local-only@localhost:5432/sent
   SENT_PASSWORD_HASH='<output of the next command>'
   SESSION_SECRET=<openssl rand -base64 32>
   TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
   ```

   Generate the login hash without storing the plaintext password:

   ```sh
   printf '%s' 'your long password' | pnpm sent:hash-password
   ```

4. Apply the database migration and run all three processes.

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

   The Vite client is at `http://localhost:5173`; it proxies API calls to `http://localhost:3000`.

## Required external credentials

Sent starts without provider or OpenAI credentials, but connecting accounts and AI features require these values in `.env`.

### OpenAI

- `OPENAI_API_KEY`
- The defaults are `gpt-5.6-luna` with xhigh reasoning for classification and `text-embedding-3-large` for search.
- Email headers and the complete normalized body are sent for classification. Very large bodies are trimmed only for the smaller embedding context.

### Google

Create a Web application OAuth client in a Google Cloud project with the Gmail API enabled.

- Authorized redirect URI: `${SENT_PUBLIC_URL}/api/oauth/gmail/callback`
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Sent requests `gmail.modify`, `gmail.send`, `openid`, `email`, and `profile` scopes.
- If the consent screen is in testing mode, add the Gmail address as a test user.

### Microsoft / Purdue

Register a confidential web application in Microsoft Entra ID.

- Redirect URI: `${SENT_PUBLIC_URL}/api/oauth/microsoft/callback`
- Delegated Microsoft Graph permission: `Mail.ReadWrite`
- Enable `openid`, `profile`, and `offline_access` through the authorization request.
- Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
- Keep `MICROSOFT_TENANT_ID=common`, or use Purdue's tenant ID if its policy requires a single-tenant app.
- Sending from Microsoft additionally requires delegated `Mail.Send`; set
  `MICROSOFT_MAIL_SEND_ENABLED=true` only after Purdue approves it.
- Purdue may require an administrator to approve the app or its delegated mail permissions.

Sent discovers the Microsoft folder tree and keeps one delta cursor per folder; Gmail uses mailbox history IDs. Native folders and labels are retained internally but are not exposed as organization controls in the MVP.

Mailbox views show one row per conversation within each account, using the latest message eligible for that view. Incoming messages determine L1/L2/L3 membership, and outgoing messages appear in Sent. Microsoft Sent Items is identified by its well-known folder ID, so sending aliases and localized folder names do not break this separation.

Before submitting a message, the outbox records a durable send attempt. Failures before submission can retry automatically; an uncertain delivery or failure to save the successful result cannot trigger another send. Such attempts are flagged for reconciliation. Microsoft messages are imported into Sent immediately after successful sending when available, with normal polling as a fallback.

Sent supports up to 10 outgoing attachments totaling 20 MB per message. Microsoft files of 3 MB or larger use chunked upload sessions; smaller files are attached individually. This applies to new messages, replies, and forwards and uses the existing `Mail.ReadWrite` and `Mail.Send` permissions. The mailbox provider may impose additional message-size limits.

## First import

After connecting each account in Settings, the worker pages through the entire archive. Imported messages remain visible in L1/Unclassified until classification completes, so an AI failure cannot hide mail.

Once the archive has arrived, run the two deliberately manual historical jobs:

```sh
pnpm sent:classify-latest
pnpm sent:classify-latest --account user@example.com
pnpm sent:classify-latest --force --limit 200
pnpm sent:embed-archive
```

The first classifies at most the newest 500 messages that do not already have a model result,
optionally restricted to one account. `--force` reprocesses the requested number of newest inbound
messages, replacing their model classification and clean Markdown reader rendition while preserving manual
tier overrides. The embedding command processes every unembedded message. The live worker
automatically classifies, generates reader text, and embeds newly synchronized messages after
`OPENAI_API_KEY` is configured.

## Production deployment

### Native production: pull-based push-to-deploy

The production box runs user systemd units as `sentinel` (linger must already
be enabled). Every two minutes `sent-deploy.timer` checks GitHub's `master` SHA.
Only a new SHA queries the GitHub check-runs API; the latest GitHub Actions
`check` job must succeed. Pending checks retry next tick; rejected checks and
failed deploys are remembered so they do not loop. No inbound webhook is needed.

Releases are built from a cached mirror into `~/sent/releases/<sha>` with
`pnpm install --frozen-lockfile` and `pnpm build`. The shared
`/opt/sent/app/.env` is symlinked, never copied. A custom-format `pg_dump` is
taken before migrations (last 10 retained), then `~/sent/current` switches
atomically and both units restart. Health requires active units, database
connectivity and a worker heartbeat after restart, not `status: "ok"`.
If sync was fresh before deployment, its oldest successful sync must also be
after restart. Old builds without `sync` do not impose that condition.
Health has a four-minute budget. Failure restores and checks the previous
release; dumps are not automatically restored. Successful releases install
their own deploy script and retain about five releases, protecting current
and previous.

One-time bootstrap on the box, as `sentinel`, from a checkout of this repository:

```sh
mkdir -p ~/sent/{bin,tools,releases,dumps,state} ~/.config/systemd/user
# Unpack a trusted Node 24 linux-arm64 tarball to ~/sent/tools/node first.
# That installation must include corepack; the runtime stays /usr/local/bin/node24.
export PATH="$HOME/sent/tools/node/bin:$PATH"
corepack enable
corepack prepare pnpm@11.21.0 --activate
# Also required on PATH: git, curl, flock, tar, pg_dump (matching the DB major).
# git ls-remote https://github.com/pmxi/sentinel.git must work non-interactively.
install -m 700 deploy/deploy.sh ~/sent/bin/deploy.sh
install -m 644 deploy/systemd/sent-{server,worker,deploy}.service deploy/systemd/sent-deploy.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable sent-server.service sent-worker.service
systemctl --user enable --now sent-deploy.timer
systemctl --user start sent-deploy.service
```

Keep `/opt/sent/app` intact: the first run registers it as
`~/sent/releases/legacy-328f56f` and uses it for rollback. Keep its `.env` in
place, readable only by the owner. Bootstrap needs no sudo; PostgreSQL must be
reachable using `DATABASE_URL` from that file. The user services keep the
existing absolute runtime and EnvironmentFile paths. Unit changes in later
releases must be installed manually; only the script self-updates.

```sh
journalctl --user -u sent-deploy -u sent-server -u sent-worker -f
systemctl --user status sent-deploy.timer
cat ~/sent/state/{deployed,failed,skipped} 2>/dev/null
readlink -f ~/sent/{current,previous}
# Stop automatic updates while investigating or intentionally pinning a rollback:
systemctl --user stop sent-deploy.timer
~/sent/bin/deploy.sh rollback
# Explicit retry / operator override: bypasses CI and failed/skipped records.
~/sent/bin/deploy.sh force <full-40-character-commit-sha>
systemctl --user start sent-deploy.timer
```

Manual commands share the timer's lock. Failures exit nonzero and log rollback
health separately. `state/failed-<sha>` and `state/skipped-<sha>` preserve history;
`state/deployed` contains the current successful SHA and UTC time. The unauthenticated
GitHub API has a shared 60-request/hour limit; API/network errors fail closed and
retry next tick. A missing check (or more than 100 check runs) stays pending.
**Migrations must remain backward-compatible with the previous release: rollback
does not undo migrations.** Copy dumps off-host and test restores separately.

For isolated local deployment tests, run `python3 deploy/test-deploy.py`.
Paths/endpoints can be overridden with `SENT_DEPLOY_ROOT`, `SENT_DEPLOY_REPO`,
`SENT_DEPLOY_CI_URL` (commits API prefix), `SENT_DEPLOY_ENV`,
`SENT_DEPLOY_LEGACY`, `SENT_DEPLOY_TOOLS`, and `SENT_DEPLOY_HEALTH`;
`SENT_DEPLOY_TIMEOUT` and `SENT_DEPLOY_INTERVAL` control health polling seconds.

### Docker deployment

1. Point a DNS record for the desired hostname at the server.
2. Set `SENT_DOMAIN=mail.example.com` and `SENT_PUBLIC_URL=https://mail.example.com` in `.env`.
   Leave `SENT_WEB_URL` blank in production so OAuth returns to `SENT_PUBLIC_URL`.
   Set `HOST=127.0.0.1` when nginx runs on the same host.
3. Use long random values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`; keep the encryption key stable or existing OAuth tokens cannot be decrypted.
4. Register the production callback URLs with Google and Microsoft.
5. Start the stack:

   ```sh
   docker compose up -d --build
   ```

Caddy obtains and renews HTTPS certificates. The app and worker use the same image with different commands. PostgreSQL and Caddy state live in named Docker volumes.

Check status with:

```sh
docker compose ps
docker compose logs -f server worker
curl -fsS --max-time 10 "https://$SENT_DOMAIN/api/health"
```

`GET /api/health` needs no credentials. For monitoring, require a JSON response with
`database: true`, `status: "ok"`, and `sync.fresh: true`; both `"ok"` and
`"degraded"` can return HTTP 200. `workerHeartbeat` reports when the worker last
ran its poll tick, not when mail was last synced. For an API/DB and sync-only
watch, check `database`, `workerHeartbeat` (at most 3 minutes old), and `sync.fresh`
separately: failed outbound mutations can also make the overall status degraded.

`sync` reports the number of connected `accounts`, how many `needsReauth`, and
how many are `stale` (never synced successfully or last successful sync more than
3 minutes ago). These counts can overlap. `oldestSuccessfulSyncAt` is the oldest
recorded successful sync across accounts, or `null` if there isn't one. Sync is
fresh when neither count is nonzero, including when there are no accounts to
sync. If the database is unavailable, `database` and `sync.fresh` are false and
the zero counts are placeholders, not evidence that no accounts exist.

## Backups

For Docker, run `scripts/backup.sh` from cron or a systemd timer. It writes compressed PostgreSQL dumps to `./backups` by default and retains 14 days. Override the destination with `SENT_BACKUP_DIR`, ideally to encrypted storage copied off the host.

On the native production host, `sent-backup.timer` is a **system** timer, separate
from the user-level deploy timer. It runs a root-installed copy of
`deploy/backup-native.sh` at `/usr/local/lib/sent/backup.sh` as the backup account
and writes private dumps under `/opt/sent/backups`. An administrator must
install updates to that copy and to the system unit; never point the system
unit at a path writable by the app's service account.

Test a custom-format dump in a fresh scratch database. Use PostgreSQL client
tools matching the source major version. Have a database administrator create
a database owned by the restore role and preinstall the extensions if that
role cannot install them. For example, on the native host:

```sh
sudo -u postgres createdb --owner=sent sent_restore_check
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d sent_restore_check \
  -c 'CREATE EXTENSION pgcrypto; CREATE EXTENSION vector;'
# Set PGHOST, PGPORT, PGUSER, and any required libpq connection options.
# Authenticate with a private .pgpass or PGPASSWORD; never put secrets in argv.
scripts/restore.sh --scratch sent_restore_check /path/to/sent-YYYYMMDDTHHMMSSZ.dump
# After verifying counts, migrations, and vector data:
dropdb --maintenance-db=postgres sent_restore_check
```

Scratch mode only accepts `sent_restore_*` names and does not create, drop, or
clean the database. It restores atomically and skips source ownership, grants,
and comments (the extension comments are owned by the administrator).

For actual disaster recovery in Docker, stop the server and worker, then run
`scripts/restore.sh /path/to/sent.dump` **without** `--scratch`. That form requires
an explicit `RESTORE` confirmation because it replaces the Compose database.

## Common commands

```sh
pnpm check                 # format, lint, types, tests
pnpm build                 # web, API, and worker production builds
pnpm db:migrate            # apply idempotent SQL migrations
pnpm sent:classify-latest  # classify newest 500 unclassified messages
pnpm sent:embed-archive    # embed the complete unembedded archive
pnpm sent:hash-password    # generate an Argon2id login hash
```

## Security notes

- The login has no signup or recovery path. It is intentionally one deployment-configured owner password.
- OAuth token caches are encrypted with AES-256-GCM before storage.
- Message bodies, access tokens, model payloads, and sign-in codes are not written to ordinary logs.
- HTML email is sanitized and rendered in a sandboxed iframe. Remote images load normally for now; proxying them is on the roadmap.
- Generated reader text supports basic Markdown, including descriptive hyperlinks. Raw HTML, images, and unsafe link schemes are disabled in this view; the original email is always available.
- The model selects short link references; Sent inserts the original URL definitions afterward so long signed links are not recopied by the model.
- The mutation outbox first records an action in PostgreSQL, updates Sent optimistically, and then retries the provider write until it succeeds or surfaces as failed.
