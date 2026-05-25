"""One-shot migration: copy tools/sources/sources.db into the postgres
`sources` schema. Idempotent at the schema level (CREATE IF NOT EXISTS)
but assumes the target tables are empty for the row-level load.

Usage:
    DATABASE_URL=postgresql://... uv run python -m tools.sources.migrate_sqlite_to_postgres
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path

import psycopg

SQLITE_PATH = Path(__file__).parent / "sources.db"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

# (sqlite_table, pg_table, columns) — column order must match in both.
TABLES_COPY = [
    (
        "collections",
        "sources.collections",
        (
            "id", "name", "notes", "platform", "source_count",
            "public", "featured", "managed", "monitored",
            "upstream_modified_at", "last_refreshed_at",
        ),
    ),
    (
        "sources",
        "sources.sources",
        (
            "id", "name", "label", "homepage", "canonical_domain",
            "platform", "media_type", "primary_language", "pub_country",
            "pub_state", "stories_per_week", "stories_total",
            "collection_count", "monitored", "last_story",
            "upstream_created_at", "upstream_modified_at",
            "last_rescraped_at", "notes", "alternative_domains",
            "last_refreshed_at",
        ),
    ),
    (
        "source_collections",
        "sources.source_collections",
        ("source_id", "collection_id"),
    ),
    (
        "source_sitemaps",
        "sources.source_sitemaps",
        (
            "source_id", "sitemap_url", "kind", "discovered_via",
            "http_status", "fresh_entries_24h", "latest_pub_date",
            "etag", "last_modified", "last_checked_at", "last_ok_at",
            "error",
        ),
    ),
]

# Identity-pk tables: preserve sqlite ids, then advance the sequence.
TABLES_IDENTITY = [
    (
        "sync_runs",
        "sources.sync_runs",
        (
            "id", "started_at", "finished_at", "collections_synced",
            "sources_synced", "error",
        ),
    ),
    (
        "discovery_runs",
        "sources.discovery_runs",
        (
            "id", "started_at", "finished_at", "sources_checked",
            "news_sitemaps_found", "error",
        ),
    ),
]


def copy_table(sqlite_conn: sqlite3.Connection, pg_conn: psycopg.Connection,
               sqlite_table: str, pg_table: str, columns: tuple[str, ...]) -> int:
    col_list = ", ".join(columns)
    select_sql = f"SELECT {col_list} FROM {sqlite_table}"
    copy_sql = f"COPY {pg_table} ({col_list}) FROM STDIN"

    total = 0
    last_log = time.monotonic()
    with pg_conn.cursor().copy(copy_sql) as cp:
        for row in sqlite_conn.execute(select_sql):
            cp.write_row(row)
            total += 1
            if total % 50000 == 0 and time.monotonic() - last_log > 1.0:
                print(f"  ... {sqlite_table}: {total:,} rows", flush=True)
                last_log = time.monotonic()
    return total


def insert_identity_table(sqlite_conn: sqlite3.Connection, pg_conn: psycopg.Connection,
                          sqlite_table: str, pg_table: str, columns: tuple[str, ...]) -> int:
    col_list = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    rows = list(sqlite_conn.execute(f"SELECT {col_list} FROM {sqlite_table}"))
    if not rows:
        return 0
    with pg_conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO {pg_table} ({col_list}) VALUES ({placeholders})",
            rows,
        )
        # Advance the identity sequence past the loaded ids.
        cur.execute(f"SELECT MAX(id) FROM {pg_table}")
        max_id = cur.fetchone()[0]
        if max_id is not None:
            cur.execute(
                f"SELECT setval(pg_get_serial_sequence(%s, 'id'), %s, true)",
                (pg_table, max_id),
            )
    return len(rows)


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: set DATABASE_URL", file=sys.stderr)
        return 2
    if not SQLITE_PATH.exists():
        print(f"ERROR: {SQLITE_PATH} not found", file=sys.stderr)
        return 2

    print(f"sqlite source: {SQLITE_PATH}")
    print(f"postgres:      {db_url.split('@')[-1]}")
    print()

    sqlite_conn = sqlite3.connect(f"file:{SQLITE_PATH}?mode=ro", uri=True)
    sqlite_conn.row_factory = None  # plain tuples for COPY/insert
    pg_conn = psycopg.connect(db_url)

    try:
        with pg_conn.transaction():
            print("Applying schema...")
            pg_conn.execute(SCHEMA_PATH.read_text())

            print("Verifying target tables are empty...")
            with pg_conn.cursor() as cur:
                for _, pg_table, _ in TABLES_COPY + TABLES_IDENTITY:
                    cur.execute(f"SELECT COUNT(*) FROM {pg_table}")
                    n = cur.fetchone()[0]
                    if n:
                        raise SystemExit(f"refusing to migrate: {pg_table} already has {n} rows")

            for sqlite_table, pg_table, cols in TABLES_COPY:
                t0 = time.monotonic()
                print(f"COPY {sqlite_table} -> {pg_table} ...", flush=True)
                n = copy_table(sqlite_conn, pg_conn, sqlite_table, pg_table, cols)
                print(f"  {n:,} rows in {time.monotonic() - t0:.1f}s")

            for sqlite_table, pg_table, cols in TABLES_IDENTITY:
                t0 = time.monotonic()
                print(f"INSERT {sqlite_table} -> {pg_table} ...", flush=True)
                n = insert_identity_table(sqlite_conn, pg_conn, sqlite_table, pg_table, cols)
                print(f"  {n} rows in {time.monotonic() - t0:.1f}s")

        print()
        print("Verifying row counts...")
        with pg_conn.cursor() as cur:
            for sqlite_table, pg_table, _ in TABLES_COPY + TABLES_IDENTITY:
                (sq_n,) = sqlite_conn.execute(f"SELECT COUNT(*) FROM {sqlite_table}").fetchone()
                cur.execute(f"SELECT COUNT(*) FROM {pg_table}")
                pg_n = cur.fetchone()[0]
                status = "OK" if sq_n == pg_n else "MISMATCH"
                print(f"  {sqlite_table:25s} sqlite={sq_n:>10,}  pg={pg_n:>10,}  {status}")
    finally:
        sqlite_conn.close()
        pg_conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
