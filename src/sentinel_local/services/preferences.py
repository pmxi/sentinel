"""Preference services for the local single-user runtime."""

from __future__ import annotations

from dataclasses import dataclass

from sentinel_local.database import LocalDatabase


@dataclass
class LocalPreferences:
    TELEGRAM_CHAT_ID: str = ""
    CLASSIFICATION_NOTES: str = ""
    EMAIL_NOTIFICATION_TO: str = ""

    @classmethod
    def load(cls, db: LocalDatabase) -> "LocalPreferences":
        raw = db.get_all_local_settings()
        kwargs = {}
        for field_name in cls.__dataclass_fields__:
            if field_name in raw:
                kwargs[field_name] = raw[field_name]
        return cls(**kwargs)

    def has_telegram(self) -> bool:
        return bool(self.TELEGRAM_CHAT_ID)


class LocalPreferencesService:
    def __init__(self, db: LocalDatabase):
        self.db = db

    def load(self) -> LocalPreferences:
        return LocalPreferences.load(self.db)

    def save_email_notification_to(self, address: str) -> None:
        address = address.strip()
        if address:
            self.db.set_local_setting("EMAIL_NOTIFICATION_TO", address)
        else:
            self.db.delete_local_setting("EMAIL_NOTIFICATION_TO")

    def save_classification_notes(self, notes: str) -> None:
        if notes.strip():
            self.db.set_local_setting("CLASSIFICATION_NOTES", notes)
        else:
            self.db.delete_local_setting("CLASSIFICATION_NOTES")

    def set_telegram_chat_id(self, chat_id: str) -> None:
        self.db.set_local_setting("TELEGRAM_CHAT_ID", chat_id)

    def clear_telegram_chat_id(self) -> None:
        self.db.delete_local_setting("TELEGRAM_CHAT_ID")
