"""Hosted user preference services."""

from __future__ import annotations

from sentinel_hosted.database import HostedDatabase
from sentinel_hosted.user_settings import UserSettings


class HostedPreferencesService:
    def __init__(self, db: HostedDatabase):
        self.db = db

    def load(self, user_id: int) -> UserSettings:
        return UserSettings.load(self.db, user_id)

    def save_email_notification_to(self, user_id: int, address: str) -> None:
        address = address.strip()
        if address:
            self.db.set_user_setting(user_id, "EMAIL_NOTIFICATION_TO", address)
        else:
            self.db.delete_user_setting(user_id, "EMAIL_NOTIFICATION_TO")

    def save_classification_notes(self, user_id: int, notes: str) -> None:
        if notes.strip():
            self.db.set_user_setting(user_id, "CLASSIFICATION_NOTES", notes)
        else:
            self.db.delete_user_setting(user_id, "CLASSIFICATION_NOTES")

    def clear_telegram_chat_id(self, user_id: int) -> None:
        self.db.delete_user_setting(user_id, "TELEGRAM_CHAT_ID")
