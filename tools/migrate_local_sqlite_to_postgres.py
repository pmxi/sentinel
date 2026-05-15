"""One-time migration from the old local SQLite store to PostgreSQL.

Reads DATABASE_URL from the environment or .env. The migration replaces the
PostgreSQL local-runtime tables with the SQLite contents.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path
from typing import Iterable, Sequence

import psycopg
from dotenv import load_dotenv

from sentinel.local.database import LocalDatabase


TABLES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("app_settings", ("key", "value", "updated_at")),
    ("local_settings", ("key", "value", "updated_at")),
    ("streams", ("name", "stream_type", "config_json", "updated_at")),
    (
        "processed_items",
        ("source_type", "item_id", "processed_at", "title", "author", "stream_name"),
    ),
    ("monitoring_state", ("key", "value", "updated_at")),
    ("live_events", ("id", "event_type", "payload_json", "created_at")),
    ("telegram_link_tokens", ("token", "created_at", "expires_at")),
)

TRUNCATE_TABLES = ", ".join(table for table, _columns in TABLES)
BATCH_SIZE = 1000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "sqlite_path",
        nargs="?",
        default="sentinel-local.db",
        help="Path to the old local SQLite database.",
    )
    parser.add_argument(
        "--skip-live-events",
        action="store_true",
        help="Do not backfill historical dashboard events.",
    )
    args = parser.parse_args()

    load_dotenv()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required.")

    sqlite_path = Path(args.sqlite_path)
    if not sqlite_path.is_file():
        raise SystemExit(f"SQLite database not found: {sqlite_path}")

    # Ensure the PostgreSQL schema exists before replacing table data.
    with LocalDatabase(database_url):
        pass

    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row
    try:
        with psycopg.connect(database_url) as target:
            with target.transaction():
                target.execute(f"TRUNCATE {TRUNCATE_TABLES} RESTART IDENTITY")
                tables = (
                    (table, columns)
                    for table, columns in TABLES
                    if table != "live_events" or not args.skip_live_events
                )
                totals = {
                    table: _copy_table(source, target, table, columns)
                    for table, columns in tables
                }
                if args.skip_live_events:
                    totals["live_events"] = 0
                target.execute(
                    """
                    SELECT setval(
                        pg_get_serial_sequence('live_events', 'id'),
                        COALESCE((SELECT MAX(id) FROM live_events), 1),
                        (SELECT COUNT(*) > 0 FROM live_events)
                    )
                    """
                )
    finally:
        source.close()

    for table, count in totals.items():
        print(f"{table}: {count}")


def _copy_table(
    source: sqlite3.Connection,
    target: psycopg.Connection,
    table: str,
    columns: Sequence[str],
) -> int:
    if not _source_has_table(source, table):
        return 0
    column_sql = ", ".join(columns)
    count = 0
    cursor = source.execute(f"SELECT {column_sql} FROM {table}")
    with target.cursor() as target_cursor:
        with target_cursor.copy(f"COPY {table} ({column_sql}) FROM STDIN") as copy:
            while True:
                rows = cursor.fetchmany(BATCH_SIZE)
                if not rows:
                    break
                for values in _row_values(rows, columns):
                    copy.write_row(values)
                count += len(rows)
    return count


def _source_has_table(source: sqlite3.Connection, table: str) -> bool:
    row = source.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _row_values(
    rows: Iterable[sqlite3.Row],
    columns: Sequence[str],
) -> list[tuple[object, ...]]:
    return [tuple(row[column] for column in columns) for row in rows]


if __name__ == "__main__":
    main()
