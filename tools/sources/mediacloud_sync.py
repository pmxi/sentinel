"""Sync the Mediacloud source catalog into a local SQLite mirror.

Usage:
    MEDIACLOUD_API_KEY=... uv run python -m tools.sources.mediacloud_sync

Pulls every collection (~1.7k) and every source (~1M) and upserts them
into tools/sources/sources.db. Idempotent: a fresh run replaces row
contents but preserves stable upstream ids. Source<->collection
membership is intentionally not synced in v1 (see README).
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any, Iterable

from tools.sources.canonicalize import canonical_domain
from tools.sources.client import MediacloudClient
from tools.sources.db import DEFAULT_DB_PATH, open_db

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


def _upsert(conn: sqlite3.Connection, table: str, columns: tuple[str, ...], rows: Iterable[tuple]) -> int:
    placeholders = ",".join("?" * len(columns))
    column_list = ",".join(columns)
    update_clause = ",".join(f"{c}=excluded.{c}" for c in columns if c != "id")
    sql = (
        f"INSERT INTO {table} ({column_list}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {update_clause}"
    )
    count = 0
    cur = conn.cursor()
    for row in rows:
        cur.execute(sql, row)
        count += 1
    return count


def sync_collections(conn: sqlite3.Connection, client: MediacloudClient) -> int:
    now = _now_iso()
    rows = []
    for c in client.iter_collections():
        rows.append(_project_collection(c, now))
    with conn:
        n = _upsert(conn, "collections", COLLECTION_COLUMNS, rows)
    logger.info("synced %d collections", n)
    return n


def sync_sources(conn: sqlite3.Connection, client: MediacloudClient) -> int:
    now = _now_iso()
    total = 0
    batch: list[tuple] = []
    BATCH_SIZE = 5000
    for s in client.iter_sources():
        batch.append(_project_source(s, now))
        if len(batch) >= BATCH_SIZE:
            with conn:
                _upsert(conn, "sources", SOURCE_COLUMNS, batch)
            total += len(batch)
            batch.clear()
            if total % PROGRESS_INTERVAL == 0 or total < PROGRESS_INTERVAL:
                logger.info("synced %d sources so far...", total)
    if batch:
        with conn:
            _upsert(conn, "sources", SOURCE_COLUMNS, batch)
        total += len(batch)
    logger.info("synced %d sources total", total)
    return total


def print_summary(conn: sqlite3.Connection, db_path) -> None:
    cur = conn.cursor()
    n_coll = cur.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
    n_src = cur.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    n_with_volume = cur.execute(
        "SELECT COUNT(*) FROM sources WHERE stories_per_week IS NOT NULL"
    ).fetchone()[0]
    n_dedup_domains = cur.execute(
        "SELECT COUNT(DISTINCT canonical_domain) FROM sources WHERE canonical_domain IS NOT NULL"
    ).fetchone()[0]
    print()
    print(f"DB: {db_path}")
    print(f"Collections:           {n_coll:>10,}")
    print(f"Sources:               {n_src:>10,}")
    print(f"  with stories/week:   {n_with_volume:>10,}")
    print(f"  unique domains:      {n_dedup_domains:>10,}")
    print()
    print("Top 10 languages by source count:")
    for lang, n in cur.execute(
        "SELECT primary_language, COUNT(*) FROM sources "
        "WHERE primary_language IS NOT NULL "
        "GROUP BY primary_language ORDER BY COUNT(*) DESC LIMIT 10"
    ):
        print(f"  {lang or '(none)':<8} {n:>8,}")
    print()
    print("Top 10 countries by source count:")
    for country, n in cur.execute(
        "SELECT pub_country, COUNT(*) FROM sources "
        "WHERE pub_country IS NOT NULL "
        "GROUP BY pub_country ORDER BY COUNT(*) DESC LIMIT 10"
    ):
        print(f"  {country or '(none)':<8} {n:>8,}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="path to SQLite DB")
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

    from pathlib import Path

    db_path = Path(args.db)
    conn = open_db(db_path)

    started_at = _now_iso()
    cur = conn.execute(
        "INSERT INTO sync_runs (started_at) VALUES (?)", (started_at,)
    )
    run_id = cur.lastrowid
    conn.commit()

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
            "UPDATE sync_runs SET finished_at=?, collections_synced=?, sources_synced=?, error=? WHERE id=?",
            (_now_iso(), n_coll, n_src, error, run_id),
        )
        conn.commit()

    print_summary(conn, db_path)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
