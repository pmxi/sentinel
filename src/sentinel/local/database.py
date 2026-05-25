"""Single-user PostgreSQL store for local Sentinel runtimes."""

from __future__ import annotations

import functools
import logging
import threading
import time
from datetime import datetime
from types import TracebackType
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

import psycopg
from psycopg.rows import dict_row

from sentinel.core.time_utils import format_iso_datetime, parse_iso_datetime, utc_now

_CURRENT_SCHEMA_VERSION = 1
_RECONNECT_BACKOFF_BASE = 0.5
_MAX_RECONNECT_ATTEMPTS = 3

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


def _with_reconnect(method: F) -> F:
    """Wrap a LocalDatabase method so transient psycopg connection errors
    drop the cached conn, reconnect, and retry once. Without this, a single
    postgres restart leaves the supervisor's long-lived connection dead
    forever (no automatic reconnection)."""
    @functools.wraps(method)
    def wrapper(self: "LocalDatabase", *args, **kwargs):
        last_exc: Optional[BaseException] = None
        for attempt in range(_MAX_RECONNECT_ATTEMPTS):
            try:
                return method(self, *args, **kwargs)
            except (psycopg.OperationalError, psycopg.InterfaceError) as exc:
                last_exc = exc
                logger.warning(
                    "postgres call %s failed (attempt %d/%d): %s; reconnecting",
                    method.__name__, attempt + 1, _MAX_RECONNECT_ATTEMPTS, exc,
                )
                try:
                    self._reconnect()
                except Exception as recon_exc:
                    logger.warning("reconnect failed: %s", recon_exc)
                    time.sleep(_RECONNECT_BACKOFF_BASE * (2 ** attempt))
        assert last_exc is not None
        raise last_exc
    return wrapper  # type: ignore[return-value]


class LocalDatabase:
    """Single-user PostgreSQL store for local CLI and local web app surfaces."""

    def __init__(self, database_url: str):
        if not database_url:
            raise ValueError("DATABASE_URL is required for the local PostgreSQL store.")
        self.database_url = database_url
        self._lock = threading.RLock()
        self.conn = psycopg.connect(database_url, row_factory=dict_row)
        self.conn.autocommit = True
        self._create_tables()

    def _reconnect(self) -> None:
        with self._lock:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = psycopg.connect(self.database_url, row_factory=dict_row)
            self.conn.autocommit = True

    def _create_tables(self) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS streams (
                    name TEXT PRIMARY KEY,
                    stream_type TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_items (
                    source_type TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    title TEXT,
                    author TEXT,
                    stream_name TEXT,
                    PRIMARY KEY (source_type, item_id)
                )
                """
            )
            self.conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_processed_items_processed_at
                ON processed_items (processed_at DESC)
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS monitoring_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_events (
                    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_live_events_id
                ON live_events (id)
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_link_tokens (
                    token TEXT PRIMARY KEY,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            self._set_schema_version(_CURRENT_SCHEMA_VERSION)

    def _get_schema_version(self) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return 0

    def _set_schema_version(self, version: int) -> None:
        self.conn.execute(
            """INSERT INTO schema_meta (key, value)
               VALUES ('schema_version', %s)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (str(version),),
        )

    def set_app_setting(self, key: str, value: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (%s, %s, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (key, value),
            )

    def get_app_setting(self, key: str) -> Optional[str]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM app_settings WHERE key = %s",
                (key,),
            ).fetchone()
        return row["value"] if row else None

    def get_all_app_settings(self) -> Dict[str, str]:
        with self._lock:
            rows = self.conn.execute("SELECT key, value FROM app_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_app_setting(self, key: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute("DELETE FROM app_settings WHERE key = %s", (key,))

    def set_local_setting(self, key: str, value: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO local_settings (key, value, updated_at)
                   VALUES (%s, %s, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (key, value),
            )

    def get_local_setting(self, key: str) -> Optional[str]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM local_settings WHERE key = %s",
                (key,),
            ).fetchone()
        return row["value"] if row else None

    def get_all_local_settings(self) -> Dict[str, str]:
        with self._lock:
            rows = self.conn.execute("SELECT key, value FROM local_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_local_setting(self, key: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute("DELETE FROM local_settings WHERE key = %s", (key,))

    def upsert_stream(self, name: str, stream_type: str, config_json: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO streams (name, stream_type, config_json, updated_at)
                   VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                   ON CONFLICT(name) DO UPDATE SET
                       stream_type = excluded.stream_type,
                       config_json = excluded.config_json,
                       updated_at = CURRENT_TIMESTAMP""",
                (name, stream_type, config_json),
            )

    def get_stream(self, name: str) -> Optional[Dict[str, str]]:
        with self._lock:
            row = self.conn.execute(
                "SELECT name, stream_type, config_json FROM streams WHERE name = %s",
                (name,),
            ).fetchone()
        return dict(row) if row else None

    def list_streams(self) -> List[Dict[str, str]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT name, stream_type, config_json FROM streams ORDER BY name"
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_stream(self, name: str) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute("DELETE FROM streams WHERE name = %s", (name,))

    def mark_item_processed(
        self,
        source_type: str,
        item_id: str,
        title: str = "",
        author: str = "",
        stream_name: str = "",
    ) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO processed_items
                       (source_type, item_id, title, author, stream_name)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (source_type, item_id) DO NOTHING""",
                (source_type, item_id, title, author, stream_name),
            )

    def is_item_processed(self, source_type: str, item_id: str) -> bool:
        with self._lock:
            row = self.conn.execute(
                "SELECT 1 FROM processed_items WHERE source_type = %s AND item_id = %s",
                (source_type, item_id),
            ).fetchone()
        return row is not None

    def get_processed_count(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) AS c FROM processed_items").fetchone()
        return int(row["c"])

    def recent_processed_items(self, limit: int = 25) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT source_type, item_id, title, author, stream_name, processed_at "
                "FROM processed_items ORDER BY processed_at DESC LIMIT %s",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_monitoring_start_time(self) -> Optional[datetime]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM monitoring_state WHERE key = 'monitoring_start_time'"
            ).fetchone()
        return _parse_datetime(row["value"]) if row else None

    def set_monitoring_start_time(self, timestamp: datetime) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO monitoring_state (key, value)
                   VALUES ('monitoring_start_time', %s)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (format_iso_datetime(timestamp),),
            )

    def get_last_check_time(self) -> Optional[datetime]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM monitoring_state WHERE key = 'last_check_time'"
            ).fetchone()
        return _parse_datetime(row["value"]) if row else None

    def update_last_check_time(self, timestamp: datetime) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO monitoring_state (key, value)
                   VALUES ('last_check_time', %s)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (format_iso_datetime(timestamp),),
            )

    def emit_live_event(self, event_type: str, payload_json: str) -> int:
        # Append-only. With autocommit=True the connection auto-COMMITs each
        # statement; the previous explicit conn.transaction() context manager
        # forced an extra BEGIN+COMMIT roundtrip per call which collapsed
        # throughput at high item rates.
        with self._lock:
            row = self.conn.execute(
                "INSERT INTO live_events (event_type, payload_json) "
                "VALUES (%s, %s) RETURNING id",
                (event_type, payload_json),
            ).fetchone()
            return int(row["id"])

    def emit_live_events_bulk(self, events: List[tuple[str, str]]) -> List[int]:
        """Bulk insert. Each event is (event_type, payload_json).
        Returns the assigned ids in input order. Used by the high-throughput
        path where per-row INSERT round-trips are the bottleneck."""
        if not events:
            return []
        with self._lock:
            # Single INSERT...VALUES with one round-trip. Postgres assigns
            # the IDENTITY values in row order which we preserve via RETURNING.
            placeholders = ",".join("(%s,%s)" for _ in events)
            flat: List[Any] = []
            for et, pj in events:
                flat.append(et); flat.append(pj)
            rows = self.conn.execute(
                f"INSERT INTO live_events (event_type, payload_json) "
                f"VALUES {placeholders} RETURNING id",
                flat,
            ).fetchall()
        return [int(r["id"]) for r in rows]

    def fetch_live_events_since(self, after_id: int, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, event_type, payload_json, created_at "
                "FROM live_events WHERE id > %s ORDER BY id ASC LIMIT %s",
                (after_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def latest_live_event_id(self) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS mx FROM live_events"
            ).fetchone()
        return int(row["mx"])

    def create_telegram_link_token(self, token: str, expires_at: datetime) -> None:
        with self._lock, self.conn.transaction():
            self.conn.execute(
                """INSERT INTO telegram_link_tokens (token, expires_at)
                   VALUES (%s, %s)""",
                (token, expires_at),
            )

    def consume_telegram_link_token(self, token: str) -> bool:
        with self._lock, self.conn.transaction():
            row = self.conn.execute(
                "SELECT expires_at FROM telegram_link_tokens WHERE token = %s",
                (token,),
            ).fetchone()
            if row is None:
                return False
            self.conn.execute(
                "DELETE FROM telegram_link_tokens WHERE token = %s",
                (token,),
            )
            return _parse_datetime(row["expires_at"]) >= utc_now()

    def purge_expired_telegram_link_tokens(self) -> int:
        with self._lock, self.conn.transaction():
            cursor = self.conn.execute(
                "DELETE FROM telegram_link_tokens WHERE expires_at < CURRENT_TIMESTAMP"
            )
            return cursor.rowcount

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def __enter__(self) -> "LocalDatabase":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        self.close()


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return parse_iso_datetime(str(value), assume_local=True)


# Auto-wrap every public, non-context-manager method on LocalDatabase with
# @_with_reconnect so transient `psycopg.OperationalError` recovers transparently.
# `close`, `_reconnect`, `__init__`, dunders, and private methods stay raw.
_RECONNECT_EXEMPT: set[str] = {
    "close", "_reconnect", "__init__", "__enter__", "__exit__",
}
for _name, _attr in list(vars(LocalDatabase).items()):
    if _name in _RECONNECT_EXEMPT or _name.startswith("_"):
        continue
    if isinstance(_attr, (staticmethod, classmethod, property)):
        continue
    if callable(_attr):
        setattr(LocalDatabase, _name, _with_reconnect(_attr))
del _name, _attr
