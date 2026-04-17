"""LocalIdentity — null-auth provider for self-hosted single-user deployments.

The first time the web app boots in local mode, we ensure a singleton user
exists (creating it if needed) and stash its id in app_settings.LOCAL_USER_ID.
Every request then implicitly belongs to that user; @login_required is a
pass-through, and /login redirects to / (so a stale bookmark doesn't 404).
"""

from functools import wraps
from typing import Callable, Optional

from flask import Flask, redirect, session, url_for

from sentinel_core.config import Settings
from sentinel_core.database import EmailDatabase
from sentinel_core.logging_config import get_logger

from .base import IdentityProvider

logger = get_logger(__name__)

# Stable identity for the local singleton — distinguishable from any real
# Google sub (which are numeric strings) so it can't ever collide.
_LOCAL_GOOGLE_SUB = "local-singleton"
_LOCAL_EMAIL = "local@sentinel"
_LOCAL_NAME = "Local user"


class LocalIdentity(IdentityProvider):
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._user_id: Optional[int] = None
        self._email: str = _LOCAL_EMAIL

    # ------------------------------------------------------------------ ABC

    def init_app(self, app: Flask) -> None:
        # Ensure the singleton user row exists before any request lands.
        self._user_id = self._ensure_singleton_user()
        # session.secret_key is still required for cookie signing; set a
        # weak default if the operator didn't configure one.
        app.secret_key = Settings.SESSION_SECRET or _LOCAL_GOOGLE_SUB

        @app.route("/login")
        def login():  # pragma: no cover - trivial
            # In local mode there's nothing to log into; bounce to dashboard.
            return redirect(url_for("dashboard"))

        @app.route("/logout", methods=["GET", "POST"])
        def logout():  # pragma: no cover - trivial
            return redirect(url_for("dashboard"))

    def login_required(self, view: Callable) -> Callable:
        @wraps(view)
        def wrapped(*args, **kwargs):
            # Make session["user_id"] available to any code that still
            # reads it directly, while keeping current_user_id() canonical.
            session["user_id"] = self._user_id
            return view(*args, **kwargs)

        return wrapped

    def current_user_id(self) -> Optional[int]:
        return self._user_id

    def current_user_email(self) -> Optional[str]:
        return self._email

    def is_enabled(self) -> bool:
        return False

    # ------------------------------------------------------------------ helpers

    def _ensure_singleton_user(self) -> int:
        db = EmailDatabase(self.db_path)
        try:
            stored = db.get_app_setting("LOCAL_USER_ID")
            if stored:
                user_id = int(stored)
                if db.get_user(user_id):
                    return user_id
                logger.warning(
                    "LOCAL_USER_ID=%s no longer matches a user row; recreating", stored
                )

            user_id = db.upsert_user(
                google_sub=_LOCAL_GOOGLE_SUB,
                email=_LOCAL_EMAIL,
                name=_LOCAL_NAME,
            )
            db.set_app_setting("LOCAL_USER_ID", str(user_id))
            logger.info("Created singleton local user id=%d", user_id)
            return user_id
        finally:
            db.close()
