"""Single-user SQLite store for local Sentinel runtimes."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, List, Optional, Type

from sentinel_lib.time_utils import format_iso_datetime, parse_iso_datetime, utc_now

_CURRENT_SCHEMA_VERSION = 1


class LocalDatabase:
    """Single-user sqlite store for local CLI and local web app surfaces."""

    def __init__(self, db_path: str = "sentinel-local.db"):
        self.db_path = Path(db_path)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self._create_tables()

    def _create_tables(self) -> None:
        with self.conn:
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
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS streams (
                    name TEXT PRIMARY KEY,
                    stream_type TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_items (
                    source_type TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    title TEXT,
                    author TEXT,
                    stream_name TEXT,
                    PRIMARY KEY (source_type, item_id)
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS monitoring_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_link_tokens (
                    token TEXT PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL
                )
                """
            )
            self._set_schema_version(_CURRENT_SCHEMA_VERSION)

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
            "SELECT value FROM app_settings WHERE key = ?",
            (key,),
        ).fetchone()
        return row["value"] if row else None

    def get_all_app_settings(self) -> Dict[str, str]:
        rows = self.conn.execute("SELECT key, value FROM app_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_app_setting(self, key: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))

    def set_local_setting(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO local_settings (key, value, updated_at)
                   VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (key, value),
            )

    def get_local_setting(self, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM local_settings WHERE key = ?",
            (key,),
        ).fetchone()
        return row["value"] if row else None

    def get_all_local_settings(self) -> Dict[str, str]:
        rows = self.conn.execute("SELECT key, value FROM local_settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def delete_local_setting(self, key: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM local_settings WHERE key = ?", (key,))

    def upsert_stream(self, name: str, stream_type: str, config_json: str) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO streams (name, stream_type, config_json, updated_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(name) DO UPDATE SET
                       stream_type = excluded.stream_type,
                       config_json = excluded.config_json,
                       updated_at = CURRENT_TIMESTAMP""",
                (name, stream_type, config_json),
            )

    def get_stream(self, name: str) -> Optional[Dict[str, str]]:
        row = self.conn.execute(
            "SELECT name, stream_type, config_json FROM streams WHERE name = ?",
            (name,),
        ).fetchone()
        return dict(row) if row else None

    def list_streams(self) -> List[Dict[str, str]]:
        rows = self.conn.execute(
            "SELECT name, stream_type, config_json FROM streams ORDER BY name"
        ).fetchall()
        return [dict(row) for row in rows]

    def delete_stream(self, name: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM streams WHERE name = ?", (name,))

    def mark_item_processed(
        self,
        source_type: str,
        item_id: str,
        title: str = "",
        author: str = "",
        stream_name: str = "",
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT OR IGNORE INTO processed_items
                       (source_type, item_id, title, author, stream_name)
                   VALUES (?, ?, ?, ?, ?)""",
                (source_type, item_id, title, author, stream_name),
            )

    def is_item_processed(self, source_type: str, item_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM processed_items WHERE source_type = ? AND item_id = ?",
            (source_type, item_id),
        ).fetchone()
        return row is not None

    def get_processed_count(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS c FROM processed_items").fetchone()
        return int(row["c"])

    def recent_processed_items(self, limit: int = 25) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT source_type, item_id, title, author, stream_name, processed_at "
            "FROM processed_items ORDER BY processed_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_monitoring_start_time(self) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE key = 'monitoring_start_time'"
        ).fetchone()
        return parse_iso_datetime(row["value"], assume_local=True) if row else None

    def set_monitoring_start_time(self, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (key, value)
                   VALUES ('monitoring_start_time', ?)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (format_iso_datetime(timestamp),),
            )

    def get_last_check_time(self) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE key = 'last_check_time'"
        ).fetchone()
        return parse_iso_datetime(row["value"], assume_local=True) if row else None

    def update_last_check_time(self, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (key, value)
                   VALUES ('last_check_time', ?)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (format_iso_datetime(timestamp),),
            )

    _LIVE_EVENTS_RETENTION_SECONDS = 3600

    def emit_live_event(self, event_type: str, payload_json: str) -> int:
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO live_events (event_type, payload_json) VALUES (?, ?)",
                (event_type, payload_json),
            )
            self.conn.execute(
                "DELETE FROM live_events WHERE created_at < datetime('now', ?)",
                (f"-{self._LIVE_EVENTS_RETENTION_SECONDS} seconds",),
            )
            return int(cursor.lastrowid)

    def fetch_live_events_since(self, after_id: int, limit: int = 100) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, event_type, payload_json, created_at "
            "FROM live_events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (after_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def latest_live_event_id(self) -> int:
        row = self.conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS mx FROM live_events"
        ).fetchone()
        return int(row["mx"])

    def create_telegram_link_token(self, token: str, expires_at: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO telegram_link_tokens (token, expires_at)
                   VALUES (?, ?)""",
                (token, format_iso_datetime(expires_at)),
            )

    def consume_telegram_link_token(self, token: str) -> bool:
        with self.conn:
            row = self.conn.execute(
                "SELECT expires_at FROM telegram_link_tokens WHERE token = ?",
                (token,),
            ).fetchone()
            if row is None:
                return False
            self.conn.execute(
                "DELETE FROM telegram_link_tokens WHERE token = ?",
                (token,),
            )
            return parse_iso_datetime(row["expires_at"], assume_local=True) >= utc_now()

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

    def close(self) -> None:
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
