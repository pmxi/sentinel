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
from typing import Any, Callable, Dict, List, Optional, Type

import psycopg
from psycopg.rows import dict_row

from sentinel.time_utils import parse_iso_datetime, utc_now

_CURRENT_SCHEMA_VERSION = 2
_RECONNECT_BACKOFF_BASE = 0.5
_MAX_RECONNECT_ATTEMPTS = 3
_SCHEMA_SQL_PATH = Path(__file__).parent / "schema.sql"

logger = logging.getLogger(__name__)


def _with_reconnect(method: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a Database method so transient psycopg connection errors
    drop the cached conn, reconnect, and retry once.

    Applied explicitly to each public method below — never call a wrapped
    method from inside another (a reconnect mid-transaction would retry only
    the inner call). Multi-statement methods own their reconnect at the top.
    """
    @functools.wraps(method)
    def wrapper(self: "Database", *args: Any, **kwargs: Any) -> Any:
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
    return wrapper


class Database:
    """Multi-tenant PostgreSQL store shared by the web console and worker.

    Schema is in schema.sql. The two key tables are `event` (one row per
    observed item, also the dedup ledger via UNIQUE(item_id))
    and `classification` (LLM result, FK to event).
    """

    def __init__(self, database_url: str):
        if not database_url:
            raise ValueError("DATABASE_URL is required for the PostgreSQL store.")
        self.database_url = database_url
        self._lock = threading.RLock()
        self.conn = psycopg.Connection[Dict[str, Any]].connect(database_url, row_factory=dict_row)
        self.conn.autocommit = True
        self._create_tables()

    def _reconnect(self) -> None:
        with self._lock:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = psycopg.Connection[Dict[str, Any]].connect(self.database_url, row_factory=dict_row)
            self.conn.autocommit = True

    def _create_tables(self) -> None:
        with self._lock:
            self.conn.execute(_SCHEMA_SQL_PATH.read_text().encode())
            self.conn.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('schema_version', %s) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(_CURRENT_SCHEMA_VERSION),),
            )

    # ----- app_user -----------------------------------------------------

    @_with_reconnect
    def upsert_user(self, google_sub: str, email: str, name: Optional[str]) -> Dict[str, Any]:
        with self._lock:
            row = self.conn.execute(
                """
                INSERT INTO app_user (google_sub, email, name)
                VALUES (%s, %s, %s)
                ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name
                RETURNING id, google_sub, email, name, criteria, telegram_chat_id
                """,
                (google_sub, email, name),
            ).fetchone()
        assert row is not None
        return row

    @_with_reconnect
    def get_user(self, user_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT id, google_sub, email, name, criteria, telegram_chat_id "
                "FROM app_user WHERE id=%s",
                (user_id,),
            ).fetchone()

    @_with_reconnect
    def set_user_criteria(self, user_id: int, criteria: Optional[str]) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE app_user SET criteria=%s WHERE id=%s", (criteria or None, user_id)
            )

    @_with_reconnect
    def set_user_telegram_chat_id(self, user_id: int, chat_id: Optional[str]) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE app_user SET telegram_chat_id=%s WHERE id=%s", (chat_id, user_id)
            )

    # ----- stream -------------------------------------------------------

    @_with_reconnect
    def upsert_stream(self, name: str, stream_type: str, config_json: str, user_id: Optional[int] = None) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO stream (name, stream_type, config_json, user_id, updated_at) "
                "VALUES (%s, %s, %s::jsonb, %s, NOW()) "
                "ON CONFLICT(name) DO UPDATE SET "
                "    stream_type = excluded.stream_type, "
                "    config_json = excluded.config_json, "
                "    user_id     = excluded.user_id, "
                "    updated_at  = NOW()",
                (name, stream_type, config_json, user_id),
            )

    @_with_reconnect
    def get_stream(self, name: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, stream_type, config_json::text AS config_json, user_id "
                "FROM stream WHERE name=%s",
                (name,),
            ).fetchone()

    @_with_reconnect
    def list_streams_for_user(self, user_id: int) -> List[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, stream_type, config_json::text AS config_json "
                "FROM stream WHERE user_id=%s ORDER BY name",
                (user_id,),
            ).fetchall()

    @_with_reconnect
    def list_streams(self) -> List[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, stream_type, config_json::text AS config_json, user_id "
                "FROM stream ORDER BY name"
            ).fetchall()

    @_with_reconnect
    def delete_stream(self, name: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM stream WHERE name=%s", (name,))

    # ----- event (dedup ledger) + classification -----------------------

    @_with_reconnect
    def is_item_processed(self, item_id: str) -> bool:
        """Cheap pre-check to skip the LLM call for already-seen items. Not a
        correctness guard — the atomic writes below settle dedup races."""
        with self._lock:
            row = self.conn.execute(
                "SELECT 1 FROM event WHERE item_id=%s",
                (item_id,),
            ).fetchone()
        return row is not None

    def _insert_event(
        self,
        *,
        item_id: str,
        stream_name: str,
        title: str,
        body: Optional[str],
        url: Optional[str],
        author: Optional[str],
        received_at: datetime,
        metadata: Optional[Dict[str, Any]],
    ) -> Optional[int]:
        """Insert the event row; return its id, or None on a dedup conflict.
        Caller holds self._lock and owns any surrounding transaction."""
        metadata_json = json.dumps(metadata) if metadata else None
        row = self.conn.execute(
            """
            INSERT INTO event (item_id, stream_name, title, body,
                               url, author, received_at, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (item_id) DO NOTHING
            RETURNING id
            """,
            (item_id, stream_name, title, body, url, author,
             received_at, metadata_json),
        ).fetchone()
        return int(row["id"]) if row else None

    @_with_reconnect
    def insert_event(self, **event_fields: Any) -> Optional[int]:
        """Insert a standalone event (the classification-disabled path only).
        Returns its id, or None if the item_id already existed."""
        with self._lock:
            return self._insert_event(**event_fields)

    @_with_reconnect
    def record_classified_event(
        self,
        *,
        priority: str,
        summary: Optional[str],
        reasoning: Optional[str],
        model: str,
        **event_fields: Any,
    ) -> bool:
        """Insert the event and its classification in one transaction.

        Returns True if newly recorded, False if the item already existed
        (another worker won the race) — in which case nothing is written and
        the caller just moves on. The two writes can no longer half-apply:
        either both land or neither does, so an item is never left with an
        event but no classification (which would dedup-skip it forever)."""
        with self._lock, self.conn.transaction():
            event_id = self._insert_event(**event_fields)
            if event_id is None:
                return False
            self.conn.execute(
                """
                INSERT INTO classification (event_id, priority, summary, reasoning, model)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (event_id, priority, summary, reasoning, model),
            )
        return True

    @_with_reconnect
    def record_failed_event(self, *, error: str, **event_fields: Any) -> bool:
        """Insert the event and a permanent-failure marker in one transaction
        so we stop retrying. Returns False if the item already existed."""
        with self._lock, self.conn.transaction():
            event_id = self._insert_event(**event_fields)
            if event_id is None:
                return False
            self.conn.execute(
                "INSERT INTO classification_failure (event_id, error) VALUES (%s, %s)",
                (event_id, error[:5000]),
            )
        return True

    # ----- telegram_link_token ------------------------------------------

    @_with_reconnect
    def create_telegram_link_token(self, token: str, expires_at: datetime, user_id: int) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO telegram_link_token (token, expires_at, user_id) VALUES (%s, %s, %s)",
                (token, expires_at, user_id),
            )

    @_with_reconnect
    def consume_telegram_link_token(self, token: str) -> Optional[int]:
        """Validate + delete a link token; return the user_id that created it, or None."""
        with self._lock:
            row = self.conn.execute(
                "SELECT expires_at, user_id FROM telegram_link_token WHERE token=%s", (token,)
            ).fetchone()
            if row is None:
                return None
            self.conn.execute("DELETE FROM telegram_link_token WHERE token=%s", (token,))
        if _parse_datetime(row["expires_at"]) < utc_now():
            return None
        return row["user_id"]

    @_with_reconnect
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

    def __enter__(self) -> "Database":
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
