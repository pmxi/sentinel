"""Hosted user resolution helpers."""

from __future__ import annotations

from typing import Optional

from sentinel_hosted.database import HostedDatabase


class HostedUserService:
    def __init__(self, db: HostedDatabase):
        self.db = db

    def find_user_id_by_email(self, email: str) -> Optional[int]:
        for user in self.db.list_users():
            if user["email"].lower() == email.lower():
                return int(user["id"])
        return None
