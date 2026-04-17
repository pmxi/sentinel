"""Stream-management service for the local runtime."""

from __future__ import annotations

import json
from typing import Any, Dict, List

from sentinel_lib.streams import all_specs, ensure_loaded
from sentinel_lib.streams.email.mail_config import MailAccountConfig, MailProvider
from sentinel_lib.streams.rss.config import RSSStreamConfig
from sentinel_local.database import LocalDatabase


class LocalStreamService:
    def __init__(self, db: LocalDatabase):
        self.db = db
        ensure_loaded()

    def specs(self):
        return all_specs()

    def list_stream_rows(self) -> List[Dict[str, Any]]:
        rows = []
        for row in self.db.list_streams():
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
                elif row["stream_type"] == "rss":
                    cfg = RSSStreamConfig.model_validate_json(row["config_json"])
                    entry["enabled"] = cfg.enabled
                    entry["detail"] = str(cfg.feed_url)
            except Exception as exc:
                entry["error"] = str(exc)
                entry["enabled"] = False
            rows.append(entry)
        return rows

    def add_stream(self, name: str, stream_type: str, config_json: str) -> None:
        if self.db.get_stream(name):
            raise ValueError(f"Stream {name!r} already exists.")
        self.db.upsert_stream(name, stream_type, config_json)

    def save_stream(self, name: str, stream_type: str, config_json: str) -> None:
        self.db.upsert_stream(name, stream_type, config_json)

    def get_stream(self, name: str) -> Dict[str, str] | None:
        return self.db.get_stream(name)

    def delete_stream(self, name: str) -> None:
        if not self.db.get_stream(name):
            raise ValueError(f"No stream named {name!r}")
        self.db.delete_stream(name)

    def toggle_stream(self, name: str) -> None:
        row = self.db.get_stream(name)
        if not row:
            raise ValueError(f"No stream named {name!r}")
        data = json.loads(row["config_json"])
        data["enabled"] = not data.get("enabled", True)
        self.db.upsert_stream(name, row["stream_type"], json.dumps(data))

    def persist_email_token(self, name: str, token_json: str) -> None:
        row = self.db.get_stream(name)
        if not row:
            return
        config = MailAccountConfig.model_validate_json(row["config_json"])
        config.auth.token_json = token_json
        self.db.upsert_stream(name, row["stream_type"], config.model_dump_json())
