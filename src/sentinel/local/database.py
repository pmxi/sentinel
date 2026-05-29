"""Single-user PostgreSQL store for local Sentinel runtimes."""

from __future__ import annotations

import functools
import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

import psycopg
from psycopg.rows import dict_row

from sentinel.core.time_utils import format_iso_datetime, parse_iso_datetime, utc_now

_CURRENT_SCHEMA_VERSION = 2
_RECONNECT_BACKOFF_BASE = 0.5
_MAX_RECONNECT_ATTEMPTS = 3
_SCHEMA_SQL_PATH = Path(__file__).parent / "schema.sql"

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


def _with_reconnect(method: F) -> F:
    """Wrap a LocalDatabase method so transient psycopg connection errors
    drop the cached conn, reconnect, and retry once."""
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
    """Single-user PostgreSQL store for local CLI + web surfaces.

    Schema is in schema.sql. The two key tables are `event` (one row per
    observed item, also the dedup ledger via UNIQUE(source_type,item_id))
    and `classification` (LLM result, FK to event).
    """

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
        with self._lock:
            self.conn.execute(_SCHEMA_SQL_PATH.read_text())
            self.conn.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('schema_version', %s) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(_CURRENT_SCHEMA_VERSION),),
            )

    # ----- app_setting --------------------------------------------------

    def set_app_setting(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO app_setting (key, value, updated_at) "
                "VALUES (%s, %s, NOW()) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=NOW()",
                (key, value),
            )

    def get_app_setting(self, key: str) -> Optional[str]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM app_setting WHERE key=%s", (key,)
            ).fetchone()
        return row["value"] if row else None

    def get_all_app_settings(self) -> Dict[str, str]:
        with self._lock:
            rows = self.conn.execute("SELECT key, value FROM app_setting").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def delete_app_setting(self, key: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM app_setting WHERE key=%s", (key,))

    # ----- local_setting ------------------------------------------------

    def set_local_setting(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO local_setting (key, value, updated_at) "
                "VALUES (%s, %s, NOW()) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=NOW()",
                (key, value),
            )

    def get_local_setting(self, key: str) -> Optional[str]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM local_setting WHERE key=%s", (key,)
            ).fetchone()
        return row["value"] if row else None

    def get_all_local_settings(self) -> Dict[str, str]:
        with self._lock:
            rows = self.conn.execute("SELECT key, value FROM local_setting").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def delete_local_setting(self, key: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM local_setting WHERE key=%s", (key,))

    # ----- stream -------------------------------------------------------

    def upsert_stream(self, name: str, stream_type: str, config_json: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO stream (name, stream_type, config_json, updated_at) "
                "VALUES (%s, %s, %s::jsonb, NOW()) "
                "ON CONFLICT(name) DO UPDATE SET "
                "    stream_type = excluded.stream_type, "
                "    config_json = excluded.config_json, "
                "    updated_at  = NOW()",
                (name, stream_type, config_json),
            )

    def get_stream(self, name: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self.conn.execute(
                "SELECT name, stream_type, config_json::text AS config_json "
                "FROM stream WHERE name=%s",
                (name,),
            ).fetchone()
        return dict(row) if row else None

    def list_streams(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT name, stream_type, config_json::text AS config_json "
                "FROM stream ORDER BY name"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_stream(self, name: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM stream WHERE name=%s", (name,))

    # ----- event (dedup ledger + content) -------------------------------

    def is_item_processed(self, source_type: str, item_id: str) -> bool:
        with self._lock:
            row = self.conn.execute(
                "SELECT 1 FROM event WHERE source_type=%s AND item_id=%s",
                (source_type, item_id),
            ).fetchone()
        return row is not None

    def insert_event(
        self,
        *,
        source_type: str,
        item_id: str,
        stream_name: str,
        title: str,
        body: Optional[str],
        url: Optional[str],
        author: Optional[str],
        received_at: datetime,
        score: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[int]:
        """Insert a new event. Returns its id, or None if (source_type, item_id)
        already existed (dedup hit)."""
        metadata_json = json.dumps(metadata) if metadata else None
        with self._lock:
            row = self.conn.execute(
                """
                INSERT INTO event (source_type, item_id, stream_name, title, body,
                                   url, author, received_at, score, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (source_type, item_id) DO NOTHING
                RETURNING id
                """,
                (source_type, item_id, stream_name, title, body, url, author,
                 received_at, score, metadata_json),
            ).fetchone()
        return int(row["id"]) if row else None

    def insert_events_bulk(self, rows: List[Dict[str, Any]]) -> List[int]:
        """Bulk-insert events. Each dict has the same keys as insert_event's
        kwargs. Returns the ids of rows actually inserted (skipped dedup hits
        are omitted)."""
        if not rows:
            return []
        params = []
        for r in rows:
            md = r.get("metadata")
            params.append((
                r["source_type"], r["item_id"], r["stream_name"], r["title"],
                r.get("body"), r.get("url"), r.get("author"),
                r["received_at"], r.get("score"),
                json.dumps(md) if md else None,
            ))
        placeholders = ",".join(["(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)"] * len(params))
        flat: List[Any] = [v for row in params for v in row]
        with self._lock:
            inserted = self.conn.execute(
                f"""
                INSERT INTO event (source_type, item_id, stream_name, title, body,
                                   url, author, received_at, score, metadata)
                VALUES {placeholders}
                ON CONFLICT (source_type, item_id) DO NOTHING
                RETURNING id
                """,
                flat,
            ).fetchall()
        return [int(r["id"]) for r in inserted]

    def recent_events(self, limit: int = 25) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, source_type, item_id, stream_name, title, url, author, "
                "received_at, observed_at "
                "FROM event ORDER BY observed_at DESC LIMIT %s",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def event_count(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) AS c FROM event").fetchone()
        return int(row["c"])

    def latest_event_id(self) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS mx FROM event"
            ).fetchone()
        return int(row["mx"])

    def fetch_events_since(self, after_id: int, limit: int = 200) -> List[Dict[str, Any]]:
        """Used by the SSE poll loop. Pulls events + (left-joined) classification
        so the caller has everything it needs in one round trip."""
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT e.id, e.source_type, e.item_id, e.stream_name, e.title,
                       e.body, e.url, e.author, e.received_at, e.observed_at,
                       e.score, e.metadata,
                       c.priority, c.summary, c.reasoning, c.classified_at
                FROM event e
                LEFT JOIN classification c ON c.event_id = e.id
                WHERE e.id > %s
                ORDER BY e.id ASC LIMIT %s
                """,
                (after_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # NOTE: there is deliberately no prune/delete-older-than helper for the
    # event table. Events are append-only and kept indefinitely; capacity is
    # handled at the infrastructure level, not by deleting rows. See the
    # comment in monitor.py.

    # ----- classification -----------------------------------------------

    def insert_classification(
        self,
        *,
        event_id: int,
        priority: str,
        summary: Optional[str],
        reasoning: Optional[str],
        model: str,
        latency_ms: Optional[int] = None,
        prompt_version: int = 1,
    ) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO classification
                    (event_id, priority, summary, reasoning, model, prompt_version, latency_ms)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (event_id) DO UPDATE SET
                    priority = excluded.priority,
                    summary = excluded.summary,
                    reasoning = excluded.reasoning,
                    model = excluded.model,
                    prompt_version = excluded.prompt_version,
                    classified_at = NOW(),
                    latency_ms = excluded.latency_ms
                """,
                (event_id, priority, summary, reasoning, model, prompt_version, latency_ms),
            )

    def insert_classification_failure(self, event_id: int, error: str) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO classification_failure (event_id, error, attempts, last_failed_at)
                VALUES (%s, %s, 1, NOW())
                ON CONFLICT (event_id) DO UPDATE SET
                    error = excluded.error,
                    attempts = classification_failure.attempts + 1,
                    last_failed_at = NOW()
                """,
                (event_id, error[:5000]),
            )

    # ----- monitoring_state --------------------------------------------

    def get_monitoring_start_time(self) -> Optional[datetime]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM monitoring_state WHERE key='monitoring_start_time'"
            ).fetchone()
        return _parse_datetime(row["value"]) if row else None

    def set_monitoring_start_time(self, timestamp: datetime) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO monitoring_state (key, value) "
                "VALUES ('monitoring_start_time', %s) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=NOW()",
                (format_iso_datetime(timestamp),),
            )

    def get_last_check_time(self) -> Optional[datetime]:
        with self._lock:
            row = self.conn.execute(
                "SELECT value FROM monitoring_state WHERE key='last_check_time'"
            ).fetchone()
        return _parse_datetime(row["value"]) if row else None

    def update_last_check_time(self, timestamp: datetime) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO monitoring_state (key, value) "
                "VALUES ('last_check_time', %s) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=NOW()",
                (format_iso_datetime(timestamp),),
            )

    # ----- telegram_link_token ------------------------------------------

    def create_telegram_link_token(self, token: str, expires_at: datetime) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO telegram_link_token (token, expires_at) VALUES (%s, %s)",
                (token, expires_at),
            )

    def consume_telegram_link_token(self, token: str) -> bool:
        with self._lock:
            row = self.conn.execute(
                "SELECT expires_at FROM telegram_link_token WHERE token=%s", (token,)
            ).fetchone()
            if row is None:
                return False
            self.conn.execute("DELETE FROM telegram_link_token WHERE token=%s", (token,))
            return _parse_datetime(row["expires_at"]) >= utc_now()

    def purge_expired_telegram_link_tokens(self) -> int:
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM telegram_link_token WHERE expires_at < NOW()"
            )
            return cur.rowcount

    # ----- lifecycle ----------------------------------------------------

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


# Auto-wrap public methods with reconnect retry. Same pattern as before.
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
