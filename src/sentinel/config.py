"""Operator/runtime settings, loaded from the environment (.env).

Operator config (DB url, OpenAI key, Telegram bot, ...) is set via environment
variables — there is no interactive setup step. Per-user preferences live in
the database (see services/preferences.py).
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")

    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "openai")
    LLM_API_KEY: str | None = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "gpt-5.4-mini")
    # Reasoning effort for gpt-5.x reasoning models: low | medium | high (or empty to disable).
    LLM_REASONING_EFFORT: str | None = os.getenv("LLM_REASONING_EFFORT", "medium")

    TELEGRAM_BOT_TOKEN: str | None = os.getenv("TELEGRAM_BOT_TOKEN")
    TELEGRAM_BOT_USERNAME: str | None = os.getenv("TELEGRAM_BOT_USERNAME")

    # Google OAuth client (sign-in via OIDC + Connect-Gmail via gmail.readonly).
    GOOGLE_CLIENT_ID: str | None = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET: str | None = os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_REDIRECT_URI: str = os.getenv(
        "GOOGLE_REDIRECT_URI", "http://localhost:8765/oauth/google/callback"
    )

    MAX_LOOKBACK_HOURS: int = int(os.getenv("MAX_LOOKBACK_HOURS", "24"))

    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "logs")
    DISABLE_FILE_LOGGING: bool = _flag("DISABLE_FILE_LOGGING")

    SESSION_SECRET: str | None = os.getenv("SESSION_SECRET")

    @classmethod
    def google_oauth_configured(cls) -> bool:
        return bool(cls.GOOGLE_CLIENT_ID and cls.GOOGLE_CLIENT_SECRET)

    @classmethod
    def require_database_url(cls) -> str:
        if not cls.DATABASE_URL:
            raise ValueError(
                "DATABASE_URL is required. Set it in .env or the service environment."
            )
        return cls.DATABASE_URL

    @classmethod
    def validate(cls) -> bool:
        if not cls.LLM_API_KEY:
            raise ValueError(
                "LLM_API_KEY (or OPENAI_API_KEY) is required. Set it in .env."
            )
        return True


settings = Settings()
