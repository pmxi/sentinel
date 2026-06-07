"""Single-user PostgreSQL store for local Sentinel runtimes."""

from __future__ import annotations

import functools
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Callable, Dict, List, Optional, Type

import psycopg
from psycopg.rows import dict_row

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
                    getattr(method, "__name__", "?"), attempt + 1, _MAX_RECONNECT_ATTEMPTS, exc,
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

    Schema is in schema.sql. The two key tables are `message` (one row per
    observed message, also the dedup ledger via UNIQUE(source_id))
    and `classification` (LLM result, FK to message).
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

    # ----- app_user -----------------------------------------------------

    @_with_reconnect
    def upsert_user(self, google_sub: str, email: str, name: Optional[str]) -> Dict[str, Any]:
        with self._lock:
            row = self.conn.execute(
                """
                INSERT INTO app_user (google_sub, email, name)
                VALUES (%s, %s, %s)
                ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name
                RETURNING id, google_sub, email, name, criteria
                """,
                (google_sub, email, name),
            ).fetchone()
        assert row is not None
        return row

    @_with_reconnect
    def get_user(self, user_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT id, google_sub, email, name, criteria "
                "FROM app_user WHERE id=%s",
                (user_id,),
            ).fetchone()

    @_with_reconnect
    def set_user_criteria(self, user_id: int, criteria: Optional[str]) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE app_user SET criteria=%s WHERE id=%s", (criteria or None, user_id)
            )

    # ----- push_subscription --------------------------------------------

    @_with_reconnect
    def add_push_subscription(
        self, user_id: int, endpoint: str, p256dh: str, auth: str
    ) -> None:
        """Register (or refresh) a device's Web Push subscription. Upsert on
        endpoint: a re-subscribe from the same device updates its keys and
        rebinds it to the current user rather than duplicating."""
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (endpoint) DO UPDATE SET
                    user_id = excluded.user_id,
                    p256dh  = excluded.p256dh,
                    auth    = excluded.auth
                """,
                (user_id, endpoint, p256dh, auth),
            )

    @_with_reconnect
    def get_push_subscriptions(self, user_id: int) -> List[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT endpoint, p256dh, auth FROM push_subscription "
                "WHERE user_id=%s ORDER BY created_at",
                (user_id,),
            ).fetchall()

    @_with_reconnect
    def delete_push_subscription(self, endpoint: str) -> None:
        """Drop a subscription — used both on user unsubscribe and when the push
        service reports the endpoint is gone (404/410)."""
        with self._lock:
            self.conn.execute(
                "DELETE FROM push_subscription WHERE endpoint=%s", (endpoint,)
            )

    # ----- inbox --------------------------------------------------------

    @_with_reconnect
    def upsert_inbox(self, name: str, config_json: str, user_id: Optional[int] = None) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO inbox (name, config_json, user_id, updated_at) "
                "VALUES (%s, %s::jsonb, %s, NOW()) "
                "ON CONFLICT(name) DO UPDATE SET "
                "    config_json = excluded.config_json, "
                "    user_id     = excluded.user_id, "
                "    updated_at  = NOW()",
                (name, config_json, user_id),
            )

    @_with_reconnect
    def get_inbox(self, name: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, config_json::text AS config_json, user_id "
                "FROM inbox WHERE name=%s",
                (name,),
            ).fetchone()

    @_with_reconnect
    def list_inboxes_for_user(self, user_id: int) -> List[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, config_json::text AS config_json "
                "FROM inbox WHERE user_id=%s ORDER BY name",
                (user_id,),
            ).fetchall()

    @_with_reconnect
    def list_inboxes(self) -> List[Dict[str, Any]]:
        with self._lock:
            return self.conn.execute(
                "SELECT name, config_json::text AS config_json, user_id "
                "FROM inbox ORDER BY name"
            ).fetchall()

    @_with_reconnect
    def delete_inbox(self, name: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM inbox WHERE name=%s", (name,))

    # ----- message (dedup ledger) + classification ---------------------

    @_with_reconnect
    def is_message_recorded(self, source_id: str) -> bool:
        """Cheap pre-check to skip the LLM call for already-seen messages. Not a
        correctness guard — the atomic writes below settle dedup races."""
        with self._lock:
            row = self.conn.execute(
                "SELECT 1 FROM message WHERE source_id=%s",
                (source_id,),
            ).fetchone()
        return row is not None

    def _insert_message(
        self,
        *,
        source_id: str,
        inbox_name: str,
        title: str,
        body: Optional[str],
        url: Optional[str],
        author: Optional[str],
        received_at: datetime,
    ) -> Optional[int]:
        """Insert the message row; return its id, or None on a dedup conflict.
        Caller holds self._lock and owns any surrounding transaction."""
        row = self.conn.execute(
            """
            INSERT INTO message (source_id, inbox_name, title, body,
                                 url, author, received_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source_id) DO NOTHING
            RETURNING id
            """,
            (source_id, inbox_name, title, body, url, author, received_at),
        ).fetchone()
        return int(row["id"]) if row else None

    @_with_reconnect
    def record_classified_message(
        self,
        *,
        priority: str,
        summary: Optional[str],
        reasoning: Optional[str],
        model: str,
        **message_fields: Any,
    ) -> bool:
        """Insert the message and its classification in one transaction.

        Returns True if newly recorded, False if the message already existed
        (another worker won the race) — in which case nothing is written and
        the caller just moves on. The two writes can no longer half-apply:
        either both land or neither does, so a message is never left with a
        row but no classification (which would dedup-skip it forever)."""
        with self._lock, self.conn.transaction():
            message_id = self._insert_message(**message_fields)
            if message_id is None:
                return False
            self.conn.execute(
                """
                INSERT INTO classification (message_id, priority, summary, reasoning, model)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (message_id, priority, summary, reasoning, model),
            )
        return True

    @_with_reconnect
    def record_failed_message(self, *, error: str, **message_fields: Any) -> bool:
        """Insert the message and a permanent-failure marker in one transaction
        so we stop retrying. Returns False if the message already existed."""
        with self._lock, self.conn.transaction():
            message_id = self._insert_message(**message_fields)
            if message_id is None:
                return False
            self.conn.execute(
                "INSERT INTO classification_failure (message_id, error) VALUES (%s, %s)",
                (message_id, error[:5000]),
            )
        return True

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
