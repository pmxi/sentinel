"""Application settings.

Only DATABASE_PATH is bootstrapped from the environment (so the daemon knows
where to look). Everything else lives in the `app_settings` table and is
populated via `settings.load(db)` during startup.
"""

import os
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from sentinel.database import EmailDatabase


class Settings:
    """Application-level settings. Values are populated from the DB on load()."""

    # ----- bootstrap (env only) -----
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "sentinel.db")

    # ----- LLM -----
    LLM_PROVIDER: str = "openai"
    LLM_API_KEY: Optional[str] = None
    LLM_MODEL: str = "gpt-5.4"
    CLASSIFICATION_NOTES: str = ""  # Appended to the base classifier prompt.

    # ----- Telegram -----
    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_CHAT_ID: Optional[str] = None

    # ----- Twilio (optional) -----
    TWILIO_ACCOUNT_SID: Optional[str] = None
    TWILIO_AUTH_TOKEN: Optional[str] = None
    TWILIO_PHONE_NUMBER: Optional[str] = None
    NOTIFICATION_PHONE_NUMBER: Optional[str] = None

    # ----- Monitoring -----
    POLL_INTERVAL_SECONDS: int = 30
    PROCESS_ONLY_UNREAD: bool = True
    MAX_LOOKBACK_HOURS: int = 24

    # ----- Logging -----
    LOG_LEVEL: str = "INFO"
    LOG_DIR: str = "logs"
    DISABLE_FILE_LOGGING: bool = False

    # ----- Gmail OAuth scopes (code-level default) -----
    GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

    @classmethod
    def load(cls, db: "EmailDatabase") -> None:
        """Populate class attributes from the app_settings table."""
        for key, raw in db.get_all_app_settings().items():
            if not hasattr(cls, key):
                continue
            default = getattr(cls, key)
            target = type(default) if default is not None else str
            setattr(cls, key, _coerce(raw, target))

    @classmethod
    def validate(cls) -> bool:
        if not cls.LLM_API_KEY:
            raise ValueError("LLM_API_KEY not configured. Run 'sentinel init'.")
        return True


def _coerce(raw: str, target: type) -> Any:
    if target is bool:
        return str(raw).strip().lower() in ("true", "1", "yes", "on")
    if target is int:
        return int(raw)
    return raw


settings = Settings()
