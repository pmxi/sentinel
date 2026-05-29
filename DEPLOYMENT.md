# Deployment

Sentinel's single live deployment runs on **`oracle`** — an Ubuntu host
reachable as the SSH alias `oracle` from a maintainer's laptop. Postgres
runs natively on the same host. Everything below assumes you have SSH
access to that host as `ubuntu`.

## Where things live on oracle

| Path | What |
|---|---|
| `/home/ubuntu/sentinel` | Git checkout (tracks `origin/master`) |
| `/home/ubuntu/sentinel/.venv` | uv-managed venv; `sentinel` console script lives here |
| `/home/ubuntu/.config/sentinel/sentinel.env` | Runtime env — holds `DATABASE_URL`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc. (chmod 600, never check in) |
| `/home/ubuntu/.config/systemd/user/sentinel.service` | systemd user unit |
| `/var/log/postgresql/postgresql-*.log` | Postgres logs (root/postgres reads) |
| `/tmp/sentinel-discovery/*.log` | Output of ad-hoc discovery walks (`discover_sitemaps`, `discover_feeds`) |

The web UI listens on **`127.0.0.1:8765`** — bound to localhost only.
Reach it from your laptop via an SSH tunnel (below).

## systemd unit

User-scoped (`systemctl --user`), not system-scoped, because it runs as
the `ubuntu` user. The unit lives at
`~/.config/systemd/user/sentinel.service` on oracle and contains:

```ini
[Service]
Type=simple
WorkingDirectory=/home/ubuntu/sentinel
EnvironmentFile=/home/ubuntu/.config/sentinel/sentinel.env
ExecStart=/home/ubuntu/sentinel/.venv/bin/sentinel web --host 127.0.0.1 --port 8765
Restart=always
RestartSec=5
LimitNOFILE=131072
MemoryHigh=3G
MemoryMax=4G
```

`MemoryMax=4G` is a guardrail — under sustained classification load
the process slowly grows memory; systemd OOM-kills past 4G and
`Restart=always` brings it back. Per-stream `_seen` sets are in-memory
only and rebuild on first poll after a restart.

## Postgres

Runs natively on oracle, listens on `localhost:5432`. Version 18.3.

- Database: `sentinel`
- Owner role used by the app: `sentinel_user`
- `postgres` superuser available via `sudo -nu postgres psql`
- The schema lives in two namespaces: `public` (runtime) and `sources` (Media Cloud catalog).

`DATABASE_URL` in the env file points at `postgresql://sentinel_user:...@localhost:5432/sentinel`.

## Reaching the web UI from your laptop

```bash
# Open SSH tunnel — leaves running in background
ssh -fN -L 8765:localhost:8765 oracle

# Open in browser
open http://127.0.0.1:8765/
```

For postgres access (e.g. running a CLI like `sentinel sources
materialize` from your laptop) tunnel 5433 -> 5432 since 5432 is
usually taken locally:

```bash
ssh -fN -L 5433:localhost:5432 oracle

# Then export a tunnel-aware DATABASE_URL for one-off commands
export DATABASE_URL='postgresql://sentinel_user:<pw>@localhost:5433/sentinel'
```

To close a tunnel: `pkill -f 'ssh -fN -L 8765'` (or the matching port).

## Web routes

| Path | What |
|---|---|
| `/` | Original dashboard (status + 2-column live feed). |
| `/live` | Multi-source live monitor with sidebar (filter by source type + top stream), full-text search, rate counters. |
| `/alerts` | Items classified as IMPORTANT (with summary + reasoning). |
| `/streams` | Stream-row management — search/filter/paginate; toggle/delete. |
| `/streams/activity` | Per-stream emission rates over a recent window. |
| `/streams/new` | Manually add a stream. |
| `/preferences`, `/prompt` | User notes + Telegram linking. |
| `/events/stream` | SSE feed used by `/`, `/live`. |

## Common management operations

All run **on oracle** (`ssh oracle` first).

```bash
# Status / health
systemctl --user status sentinel.service
systemctl --user show sentinel.service -p ActiveState,MainPID,MemoryCurrent

# Follow logs
journalctl --user -u sentinel.service -f
journalctl --user -u sentinel.service --since "5 minutes ago"

# Restart (picks up new code + systemd unit changes after daemon-reload)
systemctl --user restart sentinel.service

# Stop / start
systemctl --user stop sentinel.service
systemctl --user start sentinel.service

# Apply a unit file change
systemctl --user daemon-reload
systemctl --user restart sentinel.service
```

### Standard deploy

```bash
ssh oracle '
  cd /home/ubuntu/sentinel \
    && git fetch origin master \
    && git reset --hard origin/master \
    && systemctl --user restart sentinel.service'
```

Hot-reload picks up `stream` table changes within 30s without a restart
— deploys are only needed for code changes.

### Verifying after a deploy

```bash
ssh oracle '
  systemctl --user show sentinel.service -p ActiveState,MainPID
  journalctl --user -u sentinel.service --since "30 seconds ago" --no-pager \
    | grep -E "ERROR|Traceback|Supervising"
  curl -sS -o /dev/null -w "/ HTTP %{http_code}\n" http://127.0.0.1:8765/'
```

## Database schema

The runtime schema is in **`src/sentinel/local/schema.sql`** (applied
idempotently at every supervisor startup via
`LocalDatabase._create_tables`). The catalog schema lives in
**`tools/sources/schema.sql`** (applied by the catalog tools).

All tables use **singular names** as of the May-2026 migration.

### `public` — runtime

| Table | Purpose |
|---|---|
| `event` | One row per observed item. `UNIQUE (source_type, item_id)` is also the dedup ledger. `body` is nullable when redundant with `title`. Carries `received_at` (publisher) and `observed_at` (sentinel). |
| `classification` | LLM result per event (FK). Holds `priority`, `summary`, `reasoning`, `model`, `prompt_version`. |
| `classification_failure` | Symmetric to `classification` for failed classifies. |
| `stream` | Streams the supervisor polls. `config_json` is JSONB. |
| `app_setting`, `local_setting` | Key-value config (operator + per-user). |
| `monitoring_state` | Daemon heartbeats (`monitoring_start_time`, `last_check_time`). |
| `telegram_link_token` | Short-lived OTP for linking a Telegram chat. |
| `schema_meta` | Schema-version pointer. |

### `sources` — Media Cloud catalog

| Table | Purpose |
|---|---|
| `source` | ~1M publishers (id from MC, canonical_domain, stories_per_week, language, country). |
| `collection`, `source_collection` | MC topic groupings (membership empty in v1). |
| `source_sitemap` | Discovered Google News sitemaps (`kind` ∈ news/index/urlset/...). |
| `source_feed` | Validated RSS/Atom feeds per source. |
| `sync_run`, `discovery_run`, `feed_discovery_run` | Audit trail rows for the catalog/discovery tools. |

### Running a migration

DDL lives in checked-in SQL. For destructive or one-shot migrations,
add a file under `tools/` and run it as the postgres superuser:

```bash
ssh oracle 'sudo -nu postgres psql -d sentinel -v ON_ERROR_STOP=1 -f tools/your_migration.sql'
```

**Footgun:** if you run the migration as `postgres` and it creates new
tables, those tables are owned by `postgres` and the `sentinel_user`
role can't run `CREATE INDEX IF NOT EXISTS` against them at supervisor
startup. After any migration that creates tables, fix ownership:

```sql
ALTER TABLE <newtable> OWNER TO sentinel_user;
```

This bit us during the singular-names migration; the
`tools/migrate_to_singular_schema.sql` file is still in the tree as
reference but isn't meant to re-run.

## Adding scraping coverage

```bash
# 1. (Once / occasionally) refresh the Media Cloud catalog
MEDIACLOUD_API_KEY=... uv run python -m tools.sources.mediacloud_sync

# 2. Walk publisher sitemaps to populate sources.source_sitemap
uv run python -m tools.sources.discover_sitemaps --limit 10000 --min-spw 100 --concurrency 100

# 3. Walk homepages for RSS feeds — populates sources.source_feed
uv run python -m tools.sources.discover_feeds --limit 10000 --min-spw 100 --concurrency 100

# 4. Turn catalog rows into runtime streams (idempotent)
uv run sentinel sources materialize --limit 500 --min-fresh 50
uv run sentinel sources materialize --feeds-only --limit 200

# Optional: drop materialized streams no longer matching a filter
uv run sentinel sources materialize --limit 100 --prune
```

The supervisor's hot-reload picks up new `stream` rows within 30s — no
restart needed. `src:*` stream names come from sitemap materialization;
`src-feed:*` come from feed materialization. The `--prune` flag only
touches those prefixes.

## Classifier (OpenAI)

- Model is configured via `app_setting.LLM_MODEL` (currently
  `gpt-4o-mini`). Operator key is in `app_setting.LLM_API_KEY`.
- Kill switch lives in source: `_CLASSIFICATION_DISABLED` at the top of
  `src/sentinel/local/monitor.py`. Set to `True` to make every item
  skip the LLM call (still emits event rows).
- Per-source skip: items with `metadata.skip_classification = True`
  never reach the LLM. `BlueskyStream` does this because the firehose
  is too high-volume for per-post LLM calls.
- Concurrency cap: an `asyncio.Semaphore(48)` in
  `OpenAIItemClassifier.classify` keeps us under tier-1 RPM limits at
  ~1-2s latency per call.

## Things that need watching

| | |
|---|---|
| Memory drift | Slow growth under sustained classification load — `MemoryMax=4G` + `Restart=always` is the current backstop. Restarts cost 5min of re-priming (sitemap streams skip first-poll emission). |
| `event` size | **Append-only and kept indefinitely — there is no prune.** Grows ~150–200 MB/day (~236k rows/day) at current load. Watch disk on oracle and manage capacity at the infra level (bigger volume, table partitioning, archiving). Do **not** add a time-based prune to trim it. |
| OpenAI spend | At full Tier-A scale (~30 items/sec needing classification) the bill is meaningful. Disable via the kill switch when not actively using the classifications. |
| Long tail of streams | The single-process asyncio supervisor handles ~750-1500 streams comfortably. Beyond that, CPU pegs and memory grows. Going wider needs a worker-pool refactor. |
| Postgres backups | Not yet wired up — and now load-bearing: `event` is append-only and kept indefinitely, so its full history is **irreplaceable** if the DB is lost. The `sources.*` catalog is re-derivable from Media Cloud (hours to re-walk); `stream` and `app_setting` are also irreplaceable. Wiring up backups is a real TODO. |

## Catalog re-walk cost

For reference if you ever blow away the catalog:

| Step | Wall time | API cost |
|---|---|---|
| `mediacloud_sync` (1M sources + 1.7k collections) | ~2 hours | ~213 MC API hits |
| `discover_sitemaps --limit 10000` | ~15 min | none (publisher HTTP) |
| `discover_feeds --limit 10000` | ~10 min | none unless `--mediacloud-fallback` |
| `sources materialize` (whatever filter) | ~30 sec | none |

## Quick `psql` recipes

```bash
ssh oracle 'sudo -nu postgres psql -d sentinel'

-- Live system snapshot
SELECT
  (SELECT COUNT(*) FROM event)              AS events,
  (SELECT COUNT(*) FROM classification)     AS classifications,
  (SELECT COUNT(*) FROM stream)             AS streams,
  (SELECT MAX(observed_at) FROM event)      AS most_recent;

-- Recent throughput
SELECT source_type, COUNT(*) AS n,
       MIN(observed_at) AS first, MAX(observed_at) AS last
FROM event
WHERE observed_at > NOW() - INTERVAL '5 minutes'
GROUP BY 1 ORDER BY 2 DESC;

-- Active streams (something arrived in last 10 min)
SELECT stream_name, COUNT(*) AS items
FROM event
WHERE observed_at > NOW() - INTERVAL '10 minutes'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Important alerts
SELECT e.title, e.url, c.summary, c.classified_at
FROM classification c JOIN event e ON e.id = c.event_id
WHERE c.priority = 'important'
ORDER BY c.classified_at DESC LIMIT 20;
```
