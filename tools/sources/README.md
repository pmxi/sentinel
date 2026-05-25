# tools/sources

Mirror of the [Mediacloud](https://search.mediacloud.org/directory) source
catalog, stored in the sentinel postgres `sources` schema. Used as the seed
for news-sitemap discovery.

## Get an API key

Sign up at <https://search.mediacloud.org>, then grab an API key from your
profile page. Free tier gives 4000 hits/week — enough for ~3 full syncs.

## Run a sync

```sh
export DATABASE_URL=postgresql://sentinel_user:...@host:5432/sentinel
export MEDIACLOUD_API_KEY=<your-key>
uv run python -m tools.sources.mediacloud_sync
```

Pulls every collection (~1.7k) and every source (~1M) and upserts into
`sources.collections` and `sources.sources`. ~213 API hits at the default
page size of 5000. Takes a few minutes.

Use `--collections-only` for a cheap (2-hit) smoke test.

## One-shot migration from a SQLite snapshot

The original tooling used a local SQLite file (`sources.db`). To load an
existing snapshot into postgres without re-syncing from the API:

```sh
export DATABASE_URL=postgresql://sentinel_user:...@host:5432/sentinel
uv run python -m tools.sources.migrate_sqlite_to_postgres
```

Refuses to run against non-empty target tables. Streams via `COPY` — ~50s
for 1M rows over a typical SSH tunnel.

## What's stored

- `collections` — id, name, notes, source_count, public/featured/managed/monitored flags.
- `sources` — id, homepage, computed `canonical_domain` (lowercased, www-stripped), language, country, `stories_per_week`, `last_story`, etc.
- `source_collections` — empty in v1 (membership not synced; see below).
- `sync_runs` — one row per run for diagnostics.

## What's NOT stored (yet)

- **Source ↔ collection membership.** No global endpoint; would require
  ~1761 extra paginated calls. Add a separate sync command if/when you
  need to filter by collection.
- **RSS feeds per source.** `feed_list` is per-source — not bulk-friendly.
  Run on a filtered subset only.

## Useful queries

```sql
-- Active English-language sources, by volume.
SELECT canonical_domain, name, primary_language, pub_country, stories_per_week
FROM sources
WHERE primary_language = 'en'
  AND stories_per_week >= 50
  AND last_story >= '01/2026'
ORDER BY stories_per_week DESC
LIMIT 50;

-- Dedup ratio.
SELECT COUNT(*) AS rows, COUNT(DISTINCT canonical_domain) AS unique_domains
FROM sources;
```
