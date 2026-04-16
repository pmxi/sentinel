"""Multi-tenant SQLite store.

Schema:
  users                 identity (Google OAuth sub + email/name cache)
  app_settings          operator-level config (LLM key, Resend, etc.)
  user_settings         per-user config (Telegram creds, classification notes)
  accounts              mail accounts, scoped to a user
  processed_emails      dedup ledger, scoped to a user
  monitoring_state      per-user last-check / start timestamps

Data is scoped by user_id on every query. `app_settings` is the one
exception — it's operator state shared across all users.
"""

import sqlite3
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, List, Optional, Set, Type


# Keys that used to live in app_settings pre-multitenancy but have since
# moved to per-user user_settings. Cleared on first run under the new schema.
_LEGACY_APP_KEYS_NOW_USER_SCOPED = (
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "CLASSIFICATION_NOTES",
)


class EmailDatabase:
    """Multi-tenant sqlite store. All non-operator data is scoped by user_id."""

    def __init__(self, db_path: str = "sentinel.db"):
        self.db_path = Path(db_path)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._create_tables()

    # ------------------------------------------------------------------ schema

    def _create_tables(self):
        with self.conn:
            # Drop legacy-shaped tables (no user_id column) — clean-slate
            # migration; we haven't shipped so there's no user data to preserve.
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
                CREATE TABLE IF NOT EXISTS accounts (
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, name),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )

            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_emails (
                    user_id INTEGER NOT NULL,
                    email_id TEXT NOT NULL,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    subject TEXT,
                    sender TEXT,
                    provider TEXT NOT NULL,
                    PRIMARY KEY (user_id, email_id),
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

            # Clear any legacy per-user keys that were previously kept in
            # app_settings; they belong in user_settings now.
            placeholders = ",".join("?" for _ in _LEGACY_APP_KEYS_NOW_USER_SCOPED)
            self.conn.execute(
                f"DELETE FROM app_settings WHERE key IN ({placeholders})",
                _LEGACY_APP_KEYS_NOW_USER_SCOPED,
            )

    def _drop_legacy_tables(self) -> None:
        """Drop accounts/processed_emails/monitoring_state if they lack the
        user_id column (i.e. were created under the pre-multitenant schema)."""
        for table in ("accounts", "processed_emails", "monitoring_state"):
            cursor = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            )
            if cursor.fetchone() is None:
                continue
            cols = self.conn.execute(f"PRAGMA table_info({table})").fetchall()
            if not any(row[1] == "user_id" for row in cols):
                self.conn.execute(f"DROP TABLE {table}")

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

    # ------------------------------------------------------------------ accounts

    def upsert_account(self, user_id: int, name: str, config_json: str) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO accounts (user_id, name, config_json, updated_at)
                   VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(user_id, name) DO UPDATE SET
                       config_json = excluded.config_json,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, name, config_json),
            )

    def get_account(self, user_id: int, name: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT config_json FROM accounts WHERE user_id = ? AND name = ?",
            (user_id, name),
        ).fetchone()
        return row["config_json"] if row else None

    def list_accounts(self, user_id: int) -> Dict[str, str]:
        rows = self.conn.execute(
            "SELECT name, config_json FROM accounts WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        return {row["name"]: row["config_json"] for row in rows}

    def delete_account(self, user_id: int, name: str) -> None:
        with self.conn:
            self.conn.execute(
                "DELETE FROM accounts WHERE user_id = ? AND name = ?",
                (user_id, name),
            )

    # ------------------------------------------------------------------ processed_emails

    def mark_email_processed(
        self,
        user_id: int,
        email_id: str,
        provider: str,
        subject: str = "",
        sender: str = "",
    ) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT OR IGNORE INTO processed_emails
                       (user_id, email_id, provider, subject, sender)
                   VALUES (?, ?, ?, ?, ?)""",
                (user_id, email_id, provider, subject, sender),
            )

    def is_email_processed(self, user_id: int, email_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM processed_emails WHERE user_id = ? AND email_id = ?",
            (user_id, email_id),
        ).fetchone()
        return row is not None

    def get_processed_email_ids(self, user_id: int) -> Set[str]:
        rows = self.conn.execute(
            "SELECT email_id FROM processed_emails WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        return {row["email_id"] for row in rows}

    def get_processed_count(self, user_id: Optional[int] = None) -> int:
        """Count processed emails. If user_id is given, scope to that user;
        otherwise return a system-wide count."""
        if user_id is None:
            row = self.conn.execute(
                "SELECT COUNT(*) AS c FROM processed_emails"
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS c FROM processed_emails WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return int(row["c"])

    # ------------------------------------------------------------------ monitoring_state

    def get_monitoring_start_time(self, user_id: int) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE user_id = ? AND key = 'monitoring_start_time'",
            (user_id,),
        ).fetchone()
        return datetime.fromisoformat(row["value"]) if row else None

    def set_monitoring_start_time(self, user_id: int, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (user_id, key, value)
                   VALUES (?, 'monitoring_start_time', ?)
                   ON CONFLICT(user_id, key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, timestamp.isoformat()),
            )

    def get_last_check_time(self, user_id: int) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE user_id = ? AND key = 'last_check_time'",
            (user_id,),
        ).fetchone()
        return datetime.fromisoformat(row["value"]) if row else None

    def update_last_check_time(self, user_id: int, timestamp: datetime) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO monitoring_state (user_id, key, value)
                   VALUES (?, 'last_check_time', ?)
                   ON CONFLICT(user_id, key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = CURRENT_TIMESTAMP""",
                (user_id, timestamp.isoformat()),
            )

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
