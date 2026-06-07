"""Operator/runtime settings, loaded from the environment (.env).

Operator config (DB url, OpenAI key, VAPID keys, ...) is set via environment
variables — there is no interactive setup step. Per-user preferences live in
the database (app_user.criteria, accessed via Database).
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")

    LLM_API_KEY: str | None = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "gpt-5.4-mini")
    # Reasoning effort for gpt-5.x reasoning models: low | medium | high (or empty to disable).
    LLM_REASONING_EFFORT: str | None = os.getenv("LLM_REASONING_EFFORT", "medium")

    # Web Push (VAPID). Generate a keypair with
    #   python -m sentinel.scripts.gen_vapid_keys
    # PUBLIC_KEY is the browser-side applicationServerKey; PRIVATE_KEY is
    # base64(PEM); SUBJECT is a mailto: or https: contact the push service can
    # reach if your sends misbehave.
    VAPID_PUBLIC_KEY: str | None = os.getenv("VAPID_PUBLIC_KEY")
    VAPID_PRIVATE_KEY: str | None = os.getenv("VAPID_PRIVATE_KEY")
    VAPID_SUBJECT: str = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")

    # Google OAuth client (sign-in via OIDC + Connect-Gmail via gmail.readonly).
    GOOGLE_CLIENT_ID: str | None = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET: str | None = os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_REDIRECT_URI: str = os.getenv(
        "GOOGLE_REDIRECT_URI", "http://localhost:8765/oauth/google/callback"
    )

    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_DIR: str = os.getenv("LOG_DIR", "logs")

    SESSION_SECRET: str | None = os.getenv("SESSION_SECRET")

    @classmethod
    def google_oauth_configured(cls) -> bool:
        return bool(cls.GOOGLE_CLIENT_ID and cls.GOOGLE_CLIENT_SECRET)

    @classmethod
    def vapid_configured(cls) -> bool:
        return bool(cls.VAPID_PUBLIC_KEY and cls.VAPID_PRIVATE_KEY)

    @classmethod
    def require_database_url(cls) -> str:
        if not cls.DATABASE_URL:
            raise ValueError(
                "DATABASE_URL is required. Set it in .env or the service environment."
            )
        return cls.DATABASE_URL

    @classmethod
    def require_session_secret(cls) -> str:
        if not cls.SESSION_SECRET:
            raise ValueError(
                "SESSION_SECRET is required to sign login sessions. Generate one with "
                '`python -c "import secrets; print(secrets.token_hex(32))"` and set it in .env.'
            )
        return cls.SESSION_SECRET

    @classmethod
    def validate(cls) -> bool:
        if not cls.LLM_API_KEY:
            raise ValueError(
                "LLM_API_KEY (or OPENAI_API_KEY) is required. Set it in .env."
            )
        cls.require_vapid()
        return True

    @classmethod
    def require_vapid(cls) -> None:
        """Web Push is the only alert channel, so both halves of the VAPID
        keypair are mandatory. Generate them with
        `python -m sentinel.scripts.gen_vapid_keys`."""
        if not cls.vapid_configured():
            raise ValueError(
                "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required for Web Push "
                "alerts. Generate a keypair with "
                "`python -m sentinel.scripts.gen_vapid_keys` and set them in .env."
            )


settings = Settings()
