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
- Versioned OpenAI classification with strict `{ reasoning, tier }` output
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

Microsoft attachments are currently limited to 3 MB; larger Graph upload sessions are tracked on the roadmap. Sent caps other outgoing attachment sets at 20 MB.

## First import

After connecting each account in Settings, the worker pages through the entire archive. Imported messages remain visible in L1/Unclassified until classification completes, so an AI failure cannot hide mail.

Once the archive has arrived, run the two deliberately manual historical jobs:

```sh
pnpm sent:classify-latest
pnpm sent:classify-latest --account user@example.com
pnpm sent:embed-archive
```

The first classifies at most the newest 500 messages that do not already have a model result,
optionally restricted to one account. The second embeds every unembedded message. The live worker
automatically classifies and embeds newly synchronized messages after `OPENAI_API_KEY` is configured.

## Production deployment

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
curl -fsS https://$SENT_DOMAIN/api/health
```

## Backups

Run `scripts/backup.sh` from cron or a systemd timer. It writes compressed PostgreSQL dumps to `./backups` by default and retains 14 days. Override the destination with `SENT_BACKUP_DIR`, ideally to encrypted storage copied off the host.

Test restoration on a non-production copy:

```sh
scripts/restore.sh /path/to/sent-YYYYMMDDTHHMMSSZ.dump
```

The restore script requires an explicit `RESTORE` confirmation because it replaces the database.

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
- The mutation outbox first records an action in PostgreSQL, updates Sent optimistically, and then retries the provider write until it succeeds or surfaces as failed.
