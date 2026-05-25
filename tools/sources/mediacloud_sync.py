"""Sync the Mediacloud source catalog into the sentinel postgres `sources` schema.

Usage:
    DATABASE_URL=postgresql://... MEDIACLOUD_API_KEY=... \\
        uv run python -m tools.sources.mediacloud_sync

Pulls every collection (~1.7k) and every source (~1M) and upserts them
into sources.collections / sources.sources. Idempotent: a fresh run
replaces row contents but preserves stable upstream ids.
Source<->collection membership is intentionally not synced in v1
(see README).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any, Iterable

import psycopg

from tools.sources.canonicalize import canonical_domain
from tools.sources.client import MediacloudClient
from tools.sources.db import open_db

logger = logging.getLogger("mediacloud_sync")

PROGRESS_INTERVAL = 25000

COLLECTION_COLUMNS = (
    "id",
    "name",
    "notes",
    "platform",
    "source_count",
    "public",
    "featured",
    "managed",
    "monitored",
    "upstream_modified_at",
    "last_refreshed_at",
)

SOURCE_COLUMNS = (
    "id",
    "name",
    "label",
    "homepage",
    "canonical_domain",
    "platform",
    "media_type",
    "primary_language",
    "pub_country",
    "pub_state",
    "stories_per_week",
    "stories_total",
    "collection_count",
    "monitored",
    "last_story",
    "upstream_created_at",
    "upstream_modified_at",
    "last_rescraped_at",
    "notes",
    "alternative_domains",
    "last_refreshed_at",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bool_to_int(value: Any) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _project_collection(c: dict[str, Any], now: str) -> tuple:
    return (
        c.get("id"),
        c.get("name"),
        c.get("notes"),
        c.get("platform"),
        c.get("source_count"),
        _bool_to_int(c.get("public")),
        _bool_to_int(c.get("featured")),
        _bool_to_int(c.get("managed")),
        _bool_to_int(c.get("monitored")),
        c.get("modified_at"),
        now,
    )


def _project_source(s: dict[str, Any], now: str) -> tuple:
    alt = s.get("alternative_domains")
    return (
        s.get("id"),
        s.get("name"),
        s.get("label"),
        s.get("homepage"),
        canonical_domain(s.get("homepage")),
        s.get("platform"),
        s.get("media_type"),
        s.get("primary_language"),
        s.get("pub_country"),
        s.get("pub_state"),
        s.get("stories_per_week"),
        s.get("stories_total"),
        s.get("collection_count"),
        _bool_to_int(s.get("monitored")),
        s.get("last_story"),
        s.get("created_at"),
        s.get("modified_at"),
        s.get("last_rescraped"),
        s.get("notes"),
        json.dumps(alt) if alt else None,
        now,
    )


def _upsert(conn: psycopg.Connection, table: str, columns: tuple[str, ...], rows: Iterable[tuple]) -> int:
    placeholders = ",".join(["%s"] * len(columns))
    column_list = ",".join(columns)
    update_clause = ",".join(f"{c}=excluded.{c}" for c in columns if c != "id")
    sql = (
        f"INSERT INTO {table} ({column_list}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {update_clause}"
    )
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
        return cur.rowcount


def sync_collections(conn: psycopg.Connection, client: MediacloudClient) -> int:
    now = _now_iso()
    rows = [_project_collection(c, now) for c in client.iter_collections()]
    n = _upsert(conn, "collections", COLLECTION_COLUMNS, rows)
    logger.info("synced %d collections", n)
    return n


def sync_sources(conn: psycopg.Connection, client: MediacloudClient) -> int:
    now = _now_iso()
    total = 0
    batch: list[tuple] = []
    BATCH_SIZE = 5000
    for s in client.iter_sources():
        batch.append(_project_source(s, now))
        if len(batch) >= BATCH_SIZE:
            _upsert(conn, "sources", SOURCE_COLUMNS, batch)
            total += len(batch)
            batch.clear()
            if total % PROGRESS_INTERVAL == 0 or total < PROGRESS_INTERVAL:
                logger.info("synced %d sources so far...", total)
    if batch:
        _upsert(conn, "sources", SOURCE_COLUMNS, batch)
        total += len(batch)
    logger.info("synced %d sources total", total)
    return total


def print_summary(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM collections")
        n_coll = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) AS c FROM sources")
        n_src = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) AS c FROM sources WHERE stories_per_week IS NOT NULL")
        n_with_volume = cur.fetchone()["c"]
        cur.execute(
            "SELECT COUNT(DISTINCT canonical_domain) AS c FROM sources "
            "WHERE canonical_domain IS NOT NULL"
        )
        n_dedup_domains = cur.fetchone()["c"]
        print()
        print(f"Collections:           {n_coll:>10,}")
        print(f"Sources:               {n_src:>10,}")
        print(f"  with stories/week:   {n_with_volume:>10,}")
        print(f"  unique domains:      {n_dedup_domains:>10,}")
        print()
        print("Top 10 languages by source count:")
        cur.execute(
            "SELECT primary_language AS k, COUNT(*) AS c FROM sources "
            "WHERE primary_language IS NOT NULL "
            "GROUP BY primary_language ORDER BY c DESC LIMIT 10"
        )
        for row in cur.fetchall():
            print(f"  {row['k'] or '(none)':<8} {row['c']:>8,}")
        print()
        print("Top 10 countries by source count:")
        cur.execute(
            "SELECT pub_country AS k, COUNT(*) AS c FROM sources "
            "WHERE pub_country IS NOT NULL "
            "GROUP BY pub_country ORDER BY c DESC LIMIT 10"
        )
        for row in cur.fetchall():
            print(f"  {row['k'] or '(none)':<8} {row['c']:>8,}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--collections-only",
        action="store_true",
        help="skip the (large) source pull, sync collections only",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    client = MediacloudClient()
    quota = client.quota()
    logger.info("API quota: %s", quota)

    conn = open_db()

    started_at = _now_iso()
    row = conn.execute(
        "INSERT INTO sync_runs (started_at) VALUES (%s) RETURNING id",
        (started_at,),
    ).fetchone()
    run_id = row["id"]

    error: str | None = None
    n_coll = 0
    n_src = 0
    try:
        n_coll = sync_collections(conn, client)
        if not args.collections_only:
            n_src = sync_sources(conn, client)
    except Exception as exc:
        error = repr(exc)
        logger.exception("sync failed")
        raise
    finally:
        conn.execute(
            "UPDATE sync_runs SET finished_at=%s, collections_synced=%s, "
            "sources_synced=%s, error=%s WHERE id=%s",
            (_now_iso(), n_coll, n_src, error, run_id),
        )

    print_summary(conn)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
