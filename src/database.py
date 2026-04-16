"""Database module for tracking processed emails, monitoring state, and configuration."""

import sqlite3
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Dict, Optional, Set, Type


class EmailDatabase:
    """Manages email processing state, app settings, and accounts in SQLite."""

    def __init__(self, db_path: str = "sentinel.db"):
        """Initialize database connection and create tables if needed."""
        self.db_path = Path(db_path)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self._create_tables()

    def _create_tables(self):
        """Create database tables if they don't exist."""
        with self.conn:
            # Table for tracking processed emails
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_emails (
                    email_id TEXT PRIMARY KEY,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    subject TEXT,
                    sender TEXT,
                    provider TEXT NOT NULL
                )
            """
            )

            # Table for tracking monitoring state
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS monitoring_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # Table for application-level settings (secrets + preferences)
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # Table for mail accounts — each row stores one MailAccountConfig as JSON
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    name TEXT PRIMARY KEY,
                    config_json TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )

            # Migrate existing data if needed
            self._migrate_schema()

    def _migrate_schema(self):
        """Migrate database schema if needed."""
        # Check if provider column exists
        cursor = self.conn.execute("PRAGMA table_info(processed_emails)")
        columns = [row[1] for row in cursor.fetchall()]

        if "provider" not in columns:
            # Add provider column to existing table
            try:
                self.conn.execute(
                    "ALTER TABLE processed_emails ADD COLUMN provider TEXT"
                )
                # Set default provider for existing records
                self.conn.execute(
                    "UPDATE processed_emails SET provider = 'gmail' WHERE provider IS NULL"
                )
                self.conn.commit()
            except sqlite3.OperationalError:
                # Column might already exist, ignore
                pass

    def mark_email_processed(
        self, email_id: str, provider: str, subject: str = "", sender: str = ""
    ):
        """Mark an email as processed."""
        with self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO processed_emails (email_id, provider, subject, sender) VALUES (?, ?, ?, ?)",
                (email_id, provider, subject, sender),
            )

    def is_email_processed(self, email_id: str) -> bool:
        """Check if an email has been processed."""
        cursor = self.conn.execute(
            "SELECT 1 FROM processed_emails WHERE email_id = ?", (email_id,)
        )
        return cursor.fetchone() is not None

    def get_processed_email_ids(self) -> Set[str]:
        """Get set of all processed email IDs."""
        cursor = self.conn.execute("SELECT email_id FROM processed_emails")
        return {row["email_id"] for row in cursor}

    def get_monitoring_start_time(self) -> Optional[datetime]:
        """Get the timestamp when monitoring started."""
        cursor = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE key = 'monitoring_start_time'"
        )
        row = cursor.fetchone()
        if row:
            return datetime.fromisoformat(row["value"])
        return None

    def set_monitoring_start_time(self, timestamp: datetime):
        """Set the monitoring start time."""
        with self.conn:
            self.conn.execute(
                """INSERT OR REPLACE INTO monitoring_state (key, value) 
                   VALUES ('monitoring_start_time', ?)""",
                (timestamp.isoformat(),),
            )

    def get_last_check_time(self) -> Optional[datetime]:
        """Get the last check timestamp."""
        cursor = self.conn.execute(
            "SELECT value FROM monitoring_state WHERE key = 'last_check_time'"
        )
        row = cursor.fetchone()
        if row:
            return datetime.fromisoformat(row["value"])
        return None

    def update_last_check_time(self, timestamp: datetime):
        """Update the last check timestamp."""
        with self.conn:
            self.conn.execute(
                """INSERT OR REPLACE INTO monitoring_state (key, value) 
                   VALUES ('last_check_time', ?)""",
                (timestamp.isoformat(),),
            )

    def get_processed_count(self) -> int:
        """Get total number of processed emails."""
        cursor = self.conn.execute("SELECT COUNT(*) as count FROM processed_emails")
        return cursor.fetchone()["count"]

    # ----- app_settings -----

    def set_app_setting(self, key: str, value: str) -> None:
        """Upsert an application setting."""
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
        cursor = self.conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (key,)
        )
        row = cursor.fetchone()
        return row["value"] if row else None

    def get_all_app_settings(self) -> Dict[str, str]:
        cursor = self.conn.execute("SELECT key, value FROM app_settings")
        return {row["key"]: row["value"] for row in cursor}

    def delete_app_setting(self, key: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))

    # ----- accounts -----

    def upsert_account(self, name: str, config_json: str) -> None:
        """Upsert a mail account configuration (full MailAccountConfig as JSON)."""
        with self.conn:
            self.conn.execute(
                """INSERT INTO accounts (name, config_json, updated_at)
                   VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(name) DO UPDATE SET
                       config_json = excluded.config_json,
                       updated_at = CURRENT_TIMESTAMP""",
                (name, config_json),
            )

    def get_account(self, name: str) -> Optional[str]:
        cursor = self.conn.execute(
            "SELECT config_json FROM accounts WHERE name = ?", (name,)
        )
        row = cursor.fetchone()
        return row["config_json"] if row else None

    def list_accounts(self) -> Dict[str, str]:
        """Return all accounts as {name: config_json}."""
        cursor = self.conn.execute("SELECT name, config_json FROM accounts")
        return {row["name"]: row["config_json"] for row in cursor}

    def delete_account(self, name: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM accounts WHERE name = ?", (name,))

    def close(self):
        """Close database connection."""
        self.conn.close()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Context manager exit."""
        self.close()
