"""Stream-management service."""

from __future__ import annotations

from typing import Any, Dict, List

from sentinel.streams.email.mail_config import MailAccountConfig, MailProvider
from sentinel.database import Database


class StreamService:
    def __init__(self, db: Database):
        self.db = db

    def list_stream_rows_for_user(self, user_id: int) -> List[Dict[str, Any]]:
        return self._rows(self.db.list_streams_for_user(user_id))

    def _rows(self, streams: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        rows = []
        for row in streams:
            entry = {
                "name": row["name"],
                "stream_type": row["stream_type"],
                "enabled": True,
                "detail": "",
                "error": None,
            }
            try:
                if row["stream_type"] == "email":
                    cfg = MailAccountConfig.model_validate_json(row["config_json"])
                    entry["enabled"] = cfg.enabled
                    entry["detail"] = (
                        f"{cfg.auth.username}@{cfg.server}"
                        if cfg.provider in (MailProvider.IMAP, "imap")
                        else str(cfg.provider)
                    )
            except Exception as exc:
                entry["error"] = str(exc)
                entry["enabled"] = False
            rows.append(entry)
        return rows

    def add_stream(self, name: str, stream_type: str, config_json: str, user_id: int | None = None) -> None:
        if self.db.get_stream(name):
            raise ValueError(f"Stream {name!r} already exists.")
        self.db.upsert_stream(name, stream_type, config_json, user_id=user_id)

    def save_stream(self, name: str, stream_type: str, config_json: str, user_id: int | None = None) -> None:
        self.db.upsert_stream(name, stream_type, config_json, user_id=user_id)

    def get_stream(self, name: str) -> Dict[str, str] | None:
        return self.db.get_stream(name)

    def delete_stream(self, name: str) -> None:
        if not self.db.get_stream(name):
            raise ValueError(f"No stream named {name!r}")
        self.db.delete_stream(name)

    def persist_email_token(self, name: str, token_json: str) -> None:
        row = self.db.get_stream(name)
        if not row:
            return
        config = MailAccountConfig.model_validate_json(row["config_json"])
        config.auth.token_json = token_json
        self.db.upsert_stream(name, row["stream_type"], config.model_dump_json(), user_id=row.get("user_id"))
