# Deploying Sentinel

This describes the production deployment on a shared Ubuntu VPS that already
runs **Nginx** (reverse proxy for several sites) and a **native PostgreSQL 18**
cluster. Sentinel reuses both rather than bringing its own. Target scale is up
to 100 users (the Gmail test-mode cap).

Host in this guide: `sentinel.parasmittal.com`.

## Topology

Two long-running processes, each a systemd unit, both behind the existing Nginx:

```
                          ┌────────────────────────────────────────────┐
  Internet ── 443 ──▶ Nginx (TLS, existing) ── proxy_pass ──▶ 127.0.0.1:8765
                          │                                   sentinel-web
                          │                                   (gunicorn, N workers)
                          │
                          │   sentinel-worker  ── polls inboxes, classifies,
                          │   (one process)        sends Web Push alerts
                          │        │
                          └────────┴──▶ PostgreSQL 18 (native, localhost:5432)
```

Why web and worker are separate processes:
- A single supervisor owns classification. More than one supervisor against the
  same database = **duplicate push alerts**, so the web tier (which runs
  multiple gunicorn workers) never runs one — only the lone `sentinel-worker`.
- Independent failure domains, restarts, and logs. A wedged poll can't take
  down the console; a web deploy doesn't interrupt classification.

The worker is single-process by design — it supervises every inbox as a
concurrent asyncio task and the work is I/O-bound, which is ample for 100 users.

---

## 0. Prerequisites

- DNS: an **A record** for `sentinel.parasmittal.com` pointing at the VPS IP.
  certbot needs it resolving before it can issue a cert.
- A **Google OAuth Web client** (the same one used in dev, or a new one) with
  the Gmail API enabled. You'll register the prod redirect URI in step 7.
- A **VAPID keypair** for Web Push alerts — generated after install (step 2)
  with `python -m sentinel.scripts.gen_vapid_keys` and set in `.env` (step 4).
  Web Push also requires the console to be served over **HTTPS**, which the
  certbot step (7) provides; there is no inbound webhook to expose.
- An **OpenAI API key**.

---

## 1. Service user and directory

Run Sentinel as a dedicated, unprivileged **system user** that owns only its
app directory — never as root or your login user. The app lives in `/opt`,
the conventional home for self-contained, operator-deployed software.

```bash
sudo useradd --system --create-home --home-dir /opt/sentinel --shell /usr/sbin/nologin sentinel
```

`--system` makes a non-login service account (no aging, high-numbered UID);
`--home-dir /opt/sentinel` doubles as both the home and the app checkout, which
keeps `uv`'s cache and the code under one owned tree.

---

## 2. Clone and install

Install `uv` for the service user (systemd will call binaries out of the
project's `.venv`, so `uv` itself is only needed at deploy time):

```bash
sudo -u sentinel bash -lc '
  curl -LsSf https://astral.sh/uv/install.sh | sh
'
```

Clone the repo into the app dir and sync **production** dependencies (main +
the `prod` group that adds gunicorn; `--no-dev` skips dev-only tools):

```bash
sudo -u sentinel git clone <repo-url> /opt/sentinel/app
cd /opt/sentinel/app
sudo -u sentinel /opt/sentinel/.local/bin/uv sync --no-dev --group prod
```

This creates `/opt/sentinel/app/.venv` with the entry points
`.venv/bin/gunicorn` and `.venv/bin/sentinel-worker`, which the systemd units
call by absolute path.

---

## 3. PostgreSQL: role and database

Reuse the existing native PostgreSQL 18 cluster — just add an isolated role and
database. PostgreSQL keeps databases separate, so the other project's data and
Sentinel's never see each other.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE sentinel LOGIN PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE sentinel OWNER sentinel;
SQL
```

The schema is applied idempotently by the app on first connect — there is no
separate migration step.

> Sentinel's schema needs nothing beyond ordinary modern PostgreSQL; it runs
> fine on the existing 18 cluster. The DB listens on localhost only — never
> expose 5432 publicly.

---

## 4. Configuration (`.env`)

Create `/opt/sentinel/app/.env`, owned by the service user and `chmod 600`
(it holds secrets). Production values:

```ini
# Postgres role/db from step 3, on the local cluster.
DATABASE_URL=postgresql://sentinel:CHANGE_ME_STRONG@localhost:5432/sentinel

OPENAI_API_KEY=sk-...

# Google OAuth client. The redirect URI MUST be the public https callback and
# MUST be registered on the client (step 7).
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://sentinel.parasmittal.com/oauth/google/callback

# Flask session signing key — the web app refuses to start without it.
#   python -c "import secrets; print(secrets.token_hex(32))"
SESSION_SECRET=...

# Web Push (VAPID) — REQUIRED. Alerts have no other channel, so the web app and
# worker both refuse to start without these. Generate the keypair once, on the
# server, and paste the three printed lines here:
#   sudo -u sentinel /opt/sentinel/app/.venv/bin/python -m sentinel.scripts.gen_vapid_keys
# VAPID_SUBJECT is a contact the push services can reach — a real mailto: or
# https: you own.
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com

# Log to stdout so journald captures it (no app-managed log files).
DISABLE_FILE_LOGGING=true
LOG_LEVEL=INFO
```

```bash
sudo chown sentinel:sentinel /opt/sentinel/app/.env
sudo chmod 600 /opt/sentinel/app/.env
```

The app reads `.env` via python-dotenv, and the systemd units also load it as
an `EnvironmentFile` — same file, one source of truth.

Note: `GOOGLE_REDIRECT_URI` being `https://` is what turns on `Secure` session
cookies and keeps oauthlib in strict-HTTPS mode. The `ProxyFix` middleware
(already in `create_app`) makes `request.url` reflect that public https URL
from Nginx's forwarded headers — without it, OAuth sign-in fails behind TLS.

---

## 5. systemd units

### `/etc/systemd/system/sentinel-web.service`

```ini
[Unit]
Description=Sentinel web console (gunicorn)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=sentinel
Group=sentinel
WorkingDirectory=/opt/sentinel/app
EnvironmentFile=/opt/sentinel/app/.env
# 3 workers handle the console comfortably at this scale; threads cover the
# blocking OAuth/IMAP-probe calls. The web tier is stateless (signed-cookie
# sessions, per-request DB), so multiple workers are safe.
ExecStart=/opt/sentinel/app/.venv/bin/gunicorn 'sentinel.web.app:create_app()' \
    --workers 3 --threads 4 --bind 127.0.0.1:8765 --timeout 60
Restart=always
RestartSec=2
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/sentinel-worker.service`

```ini
[Unit]
Description=Sentinel polling + classification worker
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=sentinel
Group=sentinel
WorkingDirectory=/opt/sentinel/app
EnvironmentFile=/opt/sentinel/app/.env
ExecStart=/opt/sentinel/app/.venv/bin/sentinel-worker
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel-web sentinel-worker
sudo systemctl status sentinel-web sentinel-worker
```

`gunicorn` runs `create_app()` once per worker; the web tier never starts a
supervisor, so the lone `sentinel-worker` is the only one.

---

## 6. Nginx server block

Add a site for the host. The forwarded headers are required — they're what
`ProxyFix` reads to reconstruct the public https URL for OAuth.

`/etc/nginx/sites-available/sentinel.parasmittal.com`:

```nginx
server {
    server_name sentinel.parasmittal.com;

    location / {
        proxy_pass         http://127.0.0.1:8765;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Real-IP         $remote_addr;
    }

    listen 80;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sentinel.parasmittal.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. TLS (certbot) and Google OAuth registration

Issue the certificate (certbot rewrites the server block to add `listen 443
ssl` and the cert paths, and sets up auto-renewal):

```bash
sudo certbot --nginx -d sentinel.parasmittal.com
```

Then, in the **Google Cloud Console** for the OAuth client, add the exact
authorized redirect URI:

```
https://sentinel.parasmittal.com/oauth/google/callback
```

It must match `GOOGLE_REDIRECT_URI` in `.env` character-for-character. Also add
`https://sentinel.parasmittal.com` to the authorized JavaScript origins if the
console requires it.

---

## 8. Verify

```bash
# Both units up?
systemctl is-active sentinel-web sentinel-worker

# Web answering locally (302 -> /login is correct when unauthenticated):
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/

# Public TLS endpoint:
curl -sI https://sentinel.parasmittal.com/ | head -n1

# Worker started supervising:
journalctl -u sentinel-worker -n 20 --no-pager
```

Then open https://sentinel.parasmittal.com, sign in with Google, connect an
inbox, and click **Enable notifications** to register this browser for Web Push.

> **End-user onboarding (esp. iOS):** Web Push is delivered to the browser, and
> on iPhone/iPad it only works from an *installed* PWA — a Safari tab won't
> receive anything. Users open the site in Safari, tap **Share → Add to Home
> Screen**, open Sentinel from the new icon, then tap **Enable notifications**
> there. Desktop Chrome/Edge/Firefox and Android can enable directly from the
> tab. A user with no registered subscription classifies mail normally but
> receives nothing (logged as `notify=skipped reason=no_subscriptions`).

---

## 9. Updating / redeploying

```bash
cd /opt/sentinel/app
sudo -u sentinel git pull
sudo -u sentinel /opt/sentinel/.local/bin/uv sync --no-dev --group prod
sudo systemctl restart sentinel-web sentinel-worker
```

Restarting the worker is safe — classification is resumable (the `message`
table's UNIQUE `source_id` is the cross-restart dedup ledger).

**Two things `git pull` alone won't do — check them when deploying across a
release that changes config or schema:**

- **New required env vars.** The app fails fast if a required key is missing
  (e.g. `VAPID_*` for Web Push). After pulling a release that adds one, add it
  to `.env` *before* the restart, or both units crash-loop. Generate VAPID keys
  with `sentinel.scripts.gen_vapid_keys` (see step 4).
- **Non-additive schema changes.** The app applies `schema.sql` with
  `CREATE TABLE IF NOT EXISTS`, so it only ever *adds* tables/columns — it never
  drops or alters an existing one. A release that removes a column leaves the
  old (possibly `NOT NULL`) column in place, and inserts that no longer supply
  it will fail. Apply such drops by hand, after a backup:

  ```bash
  sudo -u postgres pg_dump -Fc email_sentinel > /var/backups/email_sentinel-$(date +%F).dump
  sudo -u postgres psql -d email_sentinel -c 'ALTER TABLE inbox DROP COLUMN <stale_column>;'
  ```

> The live database is **`email_sentinel`** (role `email_sentinel`), which
> predates this guide's `sentinel`/`sentinel_user` naming in steps 3–4. Use the
> actual name from `DATABASE_URL` in `.env` when running `psql`/`pg_dump`.

---

## 10. Operations

```bash
# Logs (journald captures stdout):
journalctl -u sentinel-web -f
journalctl -u sentinel-worker -f

# Restart / stop:
sudo systemctl restart sentinel-worker
sudo systemctl stop sentinel-web

# Tune web concurrency: edit --workers/--threads in the unit, then
sudo systemctl daemon-reload && sudo systemctl restart sentinel-web
```

### Backups

Sentinel's data is in the `sentinel` database. A daily dump (fold into the
cluster's existing backup routine if you have one):

```bash
# /etc/cron.daily/sentinel-backup  (chmod +x)
sudo -u postgres pg_dump -Fc sentinel > /var/backups/sentinel-$(date +%F).dump
```

Restore: `pg_restore -d sentinel --clean /var/backups/sentinel-<date>.dump`.

### Firewall

Only 22/80/443 should be open; PostgreSQL (5432) stays bound to localhost and
is never exposed.
