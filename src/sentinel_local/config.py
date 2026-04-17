"""Local runtime settings loaded from the local SQLite app_settings table."""

from __future__ import annotations

import os
from typing import Any, TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from sentinel_local.database import LocalDatabase


class LocalSettings:
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "sentinel-local.db")

    LLM_PROVIDER: str = "openai"
    LLM_API_KEY: Optional[str] = None
    LLM_MODEL: str = "gpt-5.4"

    RESEND_API_KEY: Optional[str] = None
    EMAIL_FROM_ADDRESS: Optional[str] = None
    EMAIL_FROM_NAME: str = ""

    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_BOT_USERNAME: Optional[str] = None

    MAX_LOOKBACK_HOURS: int = 24

    LOG_LEVEL: str = "INFO"
    LOG_DIR: str = "logs"
    DISABLE_FILE_LOGGING: bool = False

    SESSION_SECRET: Optional[str] = None

    @classmethod
    def load(cls, db: "LocalDatabase") -> None:
        for key, raw in db.get_all_app_settings().items():
            if not hasattr(cls, key):
                continue
            default = getattr(cls, key)
            target = type(default) if default is not None else str
            setattr(cls, key, _coerce(raw, target))

    @classmethod
    def validate(cls) -> bool:
        missing = []
        if not cls.LLM_API_KEY:
            missing.append("LLM_API_KEY")
        if missing:
            raise ValueError(
                f"Missing required local app settings: {', '.join(missing)}. Configure with 'sentinel init'."
            )
        return True


def _coerce(raw: str, target: type) -> Any:
    if target is bool:
        return str(raw).strip().lower() in ("true", "1", "yes", "on")
    if target is int:
        return int(raw)
    return raw


settings = LocalSettings()
