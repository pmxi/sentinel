"""Per-user preferences loaded from the user_settings table.

These live outside the global Settings class because each user has their own
values. Use UserSettings.load(db, user_id) to get a snapshot for one user.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sentinel.database import EmailDatabase


@dataclass
class UserSettings:
    """Snapshot of one user's preferences.

    Only chat_id is stored here — the Telegram bot itself is operator-shared
    (see Settings.TELEGRAM_BOT_TOKEN). A user populates chat_id by clicking
    "Link Telegram" in the UI, which walks them through /start <token>.
    """

    TELEGRAM_CHAT_ID: str = ""
    CLASSIFICATION_NOTES: str = ""
    EMAIL_NOTIFICATION_TO: str = ""  # optional: send notifications via Resend to this address

    @classmethod
    def load(cls, db: "EmailDatabase", user_id: int) -> "UserSettings":
        raw = db.get_all_user_settings(user_id)
        kwargs = {}
        for f in cls.__dataclass_fields__:
            if f in raw:
                kwargs[f] = raw[f]
        return cls(**kwargs)

    def has_telegram(self) -> bool:
        return bool(self.TELEGRAM_CHAT_ID)

    def has_email_notifications(self) -> bool:
        return bool(self.EMAIL_NOTIFICATION_TO)
