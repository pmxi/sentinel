"""Application settings.

Only DATABASE_PATH is bootstrapped from the environment (so the daemon knows
where to look). Everything else lives in the `app_settings` table and is
populated via `settings.load(db)` during startup.

Per-user preferences (Telegram creds, classification notes, etc.) live in
the `user_settings` table — NOT here. This class is for operator-level,
app-wide config only.
"""

import os
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from sentinel_core.database import EmailDatabase


class Settings:
    """Application-level settings. Values are populated from the DB on load()."""

    # ----- bootstrap (env only) -----
    DATABASE_PATH: str = os.getenv("DATABASE_PATH", "sentinel.db")

    # ----- Deployment mode -----
    # "local"  — single-user, no auth (sentinel init --local). Default.
    # "hosted" — multi-tenant, Google OAuth (sentinel init --hosted).
    DEPLOYMENT_MODE: str = "local"
    LOCAL_USER_ID: Optional[int] = None  # set by LocalIdentity on first run

    # ----- LLM (operator-paid) -----
    LLM_PROVIDER: str = "openai"
    LLM_API_KEY: Optional[str] = None
    LLM_MODEL: str = "gpt-5.4"

    # ----- Twilio (optional, operator-paid) -----
    TWILIO_ACCOUNT_SID: Optional[str] = None
    TWILIO_AUTH_TOKEN: Optional[str] = None
    TWILIO_PHONE_NUMBER: Optional[str] = None

    # ----- Resend (transactional email, operator-paid) -----
    RESEND_API_KEY: Optional[str] = None
    EMAIL_FROM_ADDRESS: Optional[str] = None
    EMAIL_FROM_NAME: str = ""

    # ----- Google OAuth (identity only — 'openid email profile' scopes) -----
    GOOGLE_CLIENT_ID: Optional[str] = None
    GOOGLE_CLIENT_SECRET: Optional[str] = None

    # ----- Telegram (shared operator bot; each user links themselves to it) -----
    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_BOT_USERNAME: Optional[str] = None

    # ----- Flask sessions -----
    SESSION_SECRET: Optional[str] = None

    # ----- Monitoring -----
    # Per-stream poll intervals live on the stream's own config (RSS: poll_seconds,
    # email: hard-coded 60s). Lookback is the cap used by new email streams when
    # they first start up — how far back to scan on initial poll.
    MAX_LOOKBACK_HOURS: int = 24

    # ----- Logging -----
    LOG_LEVEL: str = "INFO"
    LOG_DIR: str = "logs"
    DISABLE_FILE_LOGGING: bool = False

    # ----- Gmail OAuth scopes (code-level default) -----
    GMAIL_SCOPES: list[str] = ["https://www.googleapis.com/auth/gmail.readonly"]

    @classmethod
    def load(cls, db: "EmailDatabase") -> None:
        """Populate class attributes from the app_settings table."""
        for key, raw in db.get_all_app_settings().items():
            if not hasattr(cls, key):
                continue
            default = getattr(cls, key)
            target = type(default) if default is not None else str
            try:
                value = _coerce(raw, target)
            except (TypeError, ValueError) as e:
                raise ValueError(f"Invalid {key!r}: {raw!r}") from e
            setattr(cls, key, value)

    @classmethod
    def validate(cls) -> bool:
        missing = []
        if not cls.LLM_API_KEY:
            missing.append("LLM_API_KEY")
        if cls.DEPLOYMENT_MODE == "hosted":
            if not cls.GOOGLE_CLIENT_ID or not cls.GOOGLE_CLIENT_SECRET:
                missing.append("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET")
            if not cls.SESSION_SECRET:
                missing.append("SESSION_SECRET")
        if missing:
            init_cmd = "sentinel init --hosted" if cls.DEPLOYMENT_MODE == "hosted" else "sentinel init --local"
            raise ValueError(
                f"Missing required app settings for DEPLOYMENT_MODE={cls.DEPLOYMENT_MODE!r}: "
                f"{', '.join(missing)}. Configure with '{init_cmd}'."
            )
        return True


def _coerce(raw: str, target: type) -> Any:
    if target is bool:
        return str(raw).strip().lower() in ("true", "1", "yes", "on")
    if target is int:
        return int(raw)
    return raw


settings = Settings()
