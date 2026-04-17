"""Multi-tenant SQLite store.

Schema:
  users                 identity (Google OAuth sub + email/name cache)
  app_settings          operator-level config (LLM key, Resend, etc.)
  user_settings         per-user config (Telegram creds, classification notes)
  streams               per-user datastreams (email, rss, ...) as JSON blobs
  processed_items       dedup ledger, scoped by (user_id, source_type, item_id)
  monitoring_state      per-user last-check / start timestamps
  telegram_link_tokens  short-lived tokens for the /start <token> linking flow

Data is scoped by user_id on every query. `app_settings` is the one
exception — it's operator state shared across all users.
"""

import sqlite3
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, List, Optional, Type

from sentinel_core.time_utils import format_iso_datetime, parse_iso_datetime, utc_now


# Keys that only belong in user_settings — if they ever show up in
# app_settings (e.g. from a pre-multitenancy dump), the migration clears
# them. TELEGRAM_BOT_TOKEN is intentionally NOT in this list: under the
# shared-operator-bot model it lives in app_settings.
_USER_SCOPED_KEYS_WRONGLY_IN_APP_SETTINGS = (
    "TELEGRAM_CHAT_ID",
    "CLASSIFICATION_NOTES",
)
_CURRENT_SCHEMA_VERSION = 2


class EmailDatabase:
    """Multi-tenant sqlite store. All non-operator data is scoped by user_id."""

    def __init__(self, db_path: str = "sentinel.db"):
        self.db_path = Path(db_path)
        # check_same_thread=False so the async supervisor can dispatch db
        # work across asyncio.to_thread workers. Writes are still serialized
        # by SQLite's file lock.
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        # WAL lets the web process tail live_events while the supervisor
        # writes to it — no reader-blocks-writer stalls.
        self.conn.execute("PRAGMA journal_mode = WAL")
        self._create_tables()

    # ------------------------------------------------------------------ schema

    def _create_tables(self):
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            version = self._get_schema_version()

            if version < 1:
                # Clean-slate: drop any pre-Stream tables. We have not shipped
                # real user data, so a hard migration is fine.
                self._drop_legacy_tables()

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    google_sub TEXT UNIQUE NOT NULL,
                    email TEXT NOT NULL,
                    name TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login_at TIMESTAMP
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, key),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS streams (
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    stream_type TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, name),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_items (
                    user_id INTEGER NOT NULL,
                    source_type TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    title TEXT,
                    author TEXT,
                    stream_name TEXT,
                    PRIMARY KEY (user_id, source_type, item_id),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS monitoring_state (
                    user_id INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, key),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            # Ephemeral stream of events for the dashboard live feed.
            # Append-only, purged on a short window — this is UI plumbing,
            # not a ledger (processed_items is the durable ledger).
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_live_events_user_id "
                "ON live_events(user_id, id)"
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_link_tokens (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            if version < 2:
                placeholders = ",".join(
                    "?" for _ in _USER_SCOPED_KEYS_WRONGLY_IN_APP_SETTINGS
                )
                self.conn.execute(
                    f"DELETE FROM app_settings WHERE key IN ({placeholders})",
                    _USER_SCOPED_KEYS_WRONGLY_IN_APP_SETTINGS,
                )

            self._set_schema_version(_CURRENT_SCHEMA_VERSION)

    def _drop_legacy_tables(self) -> None:
        """Drop pre-Stream tables (accounts, processed_emails) outright."""
        for table in ("accounts", "processed_emails"):
            self.conn.execute(f"DROP TABLE IF EXISTS {table}")
        # Also drop streams/processed_items if they lack the current columns
        # (i.e. were created under an earlier shape of this schema).
        self._drop_if_missing_column("streams", "stream_type")
        self._drop_if_missing_column("processed_items", "source_type")

    def _drop_if_missing_column(self, table: str, required_col: str) -> None:
        cursor = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        )
        if cursor.fetchone() is None:
            return
        cols = self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        if not any(row[1] == required_col for row in cols):
            self.conn.execute(f"DROP TABLE {table}")

    def _get_schema_version(self) -> int:
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
               VALUES ('schema_version', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (str(version),),
        )

    # ------------------------------------------------------------------ users

    def upsert_user(self, google_sub: str, email: str, name: Optional[str]) -> int:
        """Create the user if new, otherwise update email/name. Returns user_id."""
        with self.conn:
            existing = self.conn.execute(
                "SELECT id FROM users WHERE google_sub = ?", (google_sub,)
            ).fetchone()
            if existing:
                self.conn.execute(
                    """UPDATE users SET email = ?, name = ?, last_login_at = CURRENT_TIMESTAMP
                       WHERE id = ?""",
                    (email, name, existing["id"]),
                )
                return int(existing["id"])
            cursor = self.conn.execute(
                """INSERT INTO users (google_sub, email, name, last_login_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)""",
                (google_sub, email, name),
            )
            return int(cursor.lastrowid)

    def get_user(self, user_id: int) -> Optional[Dict[str, Any]]:
        row = self.conn.execute(
            "SELECT id, google_sub, email, name, created_at, last_login_at "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None

    def list_users(self) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, google_sub, email, name, created_at, last_login_at "
            "FROM users ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------ app_settings

    def set_app_setting(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (key, value),
            )

    def get_app_setting(self, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else None

    def get_all_app_settings(self) -> Dict[str, str]:
        rows = self.conn.execute("SELECT key, value FROM app_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_app_setting(self, key: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))

    # ------------------------------------------------------------------ user_settings

    def set_user_setting(self, user_id: int, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO user_settings (user_id, key, value, updated_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(user_id, key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, key, value),
            )

    def get_user_setting(self, user_id: int, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM user_settings WHERE user_id = ? AND key = ?",
            (user_id, key),
        ).fetchone()
        return row["value"] if row else None

    def get_all_user_settings(self, user_id: int) -> Dict[str, str]:
        rows = self.conn.execute(
            "SELECT key, value FROM user_settings WHERE user_id = ?", (user_id,)
        ).fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_user_setting(self, user_id: int, key: str) -> None:
        with self.conn:
            self.conn.execute(
                "DELETE FROM user_settings WHERE user_id = ? AND key = ?",
                (user_id, key),
            )

    # ------------------------------------------------------------------ streams

    def upsert_stream(
        self, user_id: int, name: str, stream_type: str, config_json: str
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO streams (user_id, name, stream_type, config_json, updated_at)
                   VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(user_id, name) DO UPDATE SET
                       stream_type = excluded.stream_type,
                       config_json = excluded.config_json,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, name, stream_type, config_json),
            )

    def get_stream(self, user_id: int, name: str) -> Optional[Dict[str, str]]:
        row = self.conn.execute(
            "SELECT name, stream_type, config_json FROM streams "
            "WHERE user_id = ? AND name = ?",
            (user_id, name),
        ).fetchone()
        return dict(row) if row else None

    def list_streams(self, user_id: int) -> List[Dict[str, str]]:
        rows = self.conn.execute(
            "SELECT name, stream_type, config_json FROM streams "
            "WHERE user_id = ? ORDER BY name",
            (user_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def delete_stream(self, user_id: int, name: str) -> None:
        with self.conn:
            self.conn.execute(
                "DELETE FROM streams WHERE user_id = ? AND name = ?",
                (user_id, name),
            )

    # ------------------------------------------------------------------ processed_items

    def mark_item_processed(
        self,
        user_id: int,
        source_type: str,
        item_id: str,
        title: str = "",
        author: str = "",
        stream_name: str = "",
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT OR IGNORE INTO processed_items
                       (user_id, source_type, item_id, title, author, stream_name)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (user_id, source_type, item_id, title, author, stream_name),
            )

    def is_item_processed(
        self, user_id: int, source_type: str, item_id: str
    ) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM processed_items "
            "WHERE user_id = ? AND source_type = ? AND item_id = ?",
            (user_id, source_type, item_id),
        ).fetchone()
        return row is not None

    def get_processed_count(self, user_id: Optional[int] = None) -> int:
        """Count processed items. If user_id is given, scope to that user;
        otherwise return a system-wide count."""
        if user_id is None:
            row = self.conn.execute(
                "SELECT COUNT(*) AS c FROM processed_items"
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS c FROM processed_items WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return int(row["c"])

    def recent_processed_items(
        self, user_id: int, limit: int = 25
    ) -> List[Dict[str, Any]]:
        cursor = self.conn.execute(
            "SELECT source_type, item_id, title, author, stream_name, processed_at "
            "FROM processed_items WHERE user_id = ? "
            "ORDER BY processed_at DESC LIMIT ?",
            (user_id, limit),
        )
        return [dict(row) for row in cursor.fetchall()]

    # ------------------------------------------------------------------ monitoring_state

    def get_monitoring_start_time(self, user_id: int) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE user_id = ? AND key = 'monitoring_start_time'",
            (user_id,),
        ).fetchone()
        return parse_iso_datetime(row["value"], assume_local=True) if row else None

    def set_monitoring_start_time(self, user_id: int, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (user_id, key, value)
                   VALUES (?, 'monitoring_start_time', ?)
                   ON CONFLICT(user_id, key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, format_iso_datetime(timestamp)),
            )

    def get_last_check_time(self, user_id: int) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE user_id = ? AND key = 'last_check_time'",
            (user_id,),
        ).fetchone()
        return parse_iso_datetime(row["value"], assume_local=True) if row else None

    def update_last_check_time(self, user_id: int, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (user_id, key, value)
                   VALUES (?, 'last_check_time', ?)
                   ON CONFLICT(user_id, key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, format_iso_datetime(timestamp)),
            )

    # ------------------------------------------------------------------ live_events

    # Events older than this are purged opportunistically on write. One hour
    # is plenty — the live feed is for "what's happening right now", not a
    # replay buffer.
    _LIVE_EVENTS_RETENTION_SECONDS = 3600

    def emit_live_event(
        self, user_id: int, event_type: str, payload_json: str
    ) -> int:
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO live_events (user_id, event_type, payload_json) "
                "VALUES (?, ?, ?)",
                (user_id, event_type, payload_json),
            )
            # Opportunistic purge — cheap, bounded.
            self.conn.execute(
                "DELETE FROM live_events "
                "WHERE created_at < datetime('now', ?)",
                (f"-{self._LIVE_EVENTS_RETENTION_SECONDS} seconds",),
            )
            return int(cursor.lastrowid)

    def fetch_live_events_since(
        self, user_id: int, after_id: int, limit: int = 100
    ) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, event_type, payload_json, created_at "
            "FROM live_events WHERE user_id = ? AND id > ? "
            "ORDER BY id ASC LIMIT ?",
            (user_id, after_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def latest_live_event_id(self, user_id: int) -> int:
        row = self.conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS mx FROM live_events WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        return int(row["mx"])

    # ------------------------------------------------------------------ telegram_link_tokens

    def create_telegram_link_token(
        self, user_id: int, token: str, expires_at: datetime
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO telegram_link_tokens (token, user_id, expires_at)
                   VALUES (?, ?, ?)""",
                (token, user_id, format_iso_datetime(expires_at)),
            )

    def consume_telegram_link_token(self, token: str) -> Optional[int]:
        with self.conn:
            row = self.conn.execute(
                "SELECT user_id, expires_at FROM telegram_link_tokens WHERE token = ?",
                (token,),
            ).fetchone()
            if row is None:
                return None
            self.conn.execute(
                "DELETE FROM telegram_link_tokens WHERE token = ?", (token,)
            )
            if parse_iso_datetime(row["expires_at"], assume_local=True) < utc_now():
                return None
            return int(row["user_id"])

    def purge_expired_telegram_link_tokens(self) -> int:
        with self.conn:
            rows = self.conn.execute(
                "SELECT token, expires_at FROM telegram_link_tokens"
            ).fetchall()
            expired = [
                row["token"]
                for row in rows
                if parse_iso_datetime(row["expires_at"], assume_local=True) < utc_now()
            ]
            if not expired:
                return 0
            placeholders = ",".join("?" for _ in expired)
            cursor = self.conn.execute(
                f"DELETE FROM telegram_link_tokens WHERE token IN ({placeholders})",
                expired,
            )
            return cursor.rowcount

    # ------------------------------------------------------------------ lifecycle

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        self.close()
