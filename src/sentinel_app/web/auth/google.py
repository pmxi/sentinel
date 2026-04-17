"""GoogleOAuthIdentity — multi-tenant signup/login via Google OAuth.

Identity scopes only ('openid email profile'), so no Google verification
is required. Lifted verbatim from the previous web/app.py implementation;
no behavioral change.
"""

from functools import wraps
from typing import Callable, Optional

from authlib.integrations.flask_client import OAuth
from flask import Flask, abort, redirect, session, url_for

from sentinel_core.config import Settings
from sentinel_core.database import EmailDatabase
from sentinel_core.logging_config import get_logger

from .base import IdentityProvider

logger = get_logger(__name__)

_GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"


class GoogleOAuthIdentity(IdentityProvider):
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._oauth: Optional[OAuth] = None

    # ------------------------------------------------------------------ ABC

    def init_app(self, app: Flask) -> None:
        if not Settings.SESSION_SECRET:
            raise RuntimeError(
                "SESSION_SECRET not configured. Run 'sentinel init --hosted' first."
            )
        if not Settings.GOOGLE_CLIENT_ID or not Settings.GOOGLE_CLIENT_SECRET:
            raise RuntimeError(
                "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured. "
                "Run 'sentinel init --hosted' first."
            )

        app.secret_key = Settings.SESSION_SECRET

        oauth = OAuth(app)
        oauth.register(
            name="google",
            client_id=Settings.GOOGLE_CLIENT_ID,
            client_secret=Settings.GOOGLE_CLIENT_SECRET,
            server_metadata_url=_GOOGLE_DISCOVERY_URL,
            client_kwargs={"scope": "openid email profile"},
        )
        self._oauth = oauth

        @app.route("/login")
        def login():
            from flask import render_template
            return render_template("login.html")

        @app.route("/auth/google/start")
        def auth_google_start():
            redirect_uri = url_for("auth_google_callback", _external=True)
            return oauth.google.authorize_redirect(redirect_uri)

        @app.route("/auth/google/callback")
        def auth_google_callback():
            token = oauth.google.authorize_access_token()
            userinfo = token.get("userinfo") or oauth.google.parse_id_token(token, None)
            if not userinfo or "sub" not in userinfo:
                abort(400, "Google did not return a user identity")

            db = EmailDatabase(self.db_path)
            try:
                user_id = db.upsert_user(
                    google_sub=userinfo["sub"],
                    email=userinfo.get("email", ""),
                    name=userinfo.get("name"),
                )
            finally:
                db.close()

            session["user_id"] = user_id
            session["email"] = userinfo.get("email", "")
            session["name"] = userinfo.get("name", "")
            return redirect(url_for("dashboard"))

        @app.route("/logout", methods=["POST"])
        def logout():
            session.clear()
            return redirect(url_for("login"))

    def login_required(self, view: Callable) -> Callable:
        @wraps(view)
        def wrapped(*args, **kwargs):
            if session.get("user_id") is None:
                return redirect(url_for("login"))
            return view(*args, **kwargs)

        return wrapped

    def current_user_id(self) -> Optional[int]:
        return session.get("user_id")

    def current_user_email(self) -> Optional[str]:
        return session.get("email")

    def is_enabled(self) -> bool:
        return True
