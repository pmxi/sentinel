"""Sentinel web console (multi-tenant).

Sign in with Google, connect inboxes (Gmail via OAuth, or any provider via
IMAP app-password), edit your classification criteria, and link Telegram.
Everything is scoped to the signed-in user. The console never displays email
content — alerts go out-of-band (Telegram); the inbox lives in your mail client.
"""

from __future__ import annotations

import asyncio
import secrets
import threading
from datetime import timedelta
from typing import Any, Dict, List, Optional

from flask import Flask, abort, g, redirect, render_template, request, session, url_for

from sentinel.logging_config import get_logger
from sentinel.classifier.openai_classifier import _default_criteria
from sentinel.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel.time_utils import utc_now
from sentinel.config import settings
from sentinel.database import Database
from sentinel.monitor import Monitor
from sentinel.web.auth import GMAIL_SCOPES, SIGNIN_SCOPES, build_flow, client_config_json, userinfo_from_credentials
from sentinel.web.imap_probe import probe_imap

logger = get_logger(__name__)

_PUBLIC_ENDPOINTS = {"login", "auth_google", "oauth_callback", "static"}


def create_app(database_url: Optional[str] = None, debug: bool = False) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.debug = debug
    app.config["DATABASE_URL"] = database_url or settings.require_database_url()
    app.secret_key = settings.require_session_secret()
    _maybe_start_embedded_monitor(app)

    def get_db() -> Database:
        """One Database per request, opened lazily and closed on teardown."""
        if "db" not in g:
            g.db = Database(app.config["DATABASE_URL"])
        return g.db

    @app.teardown_appcontext
    def _close_db(_exc: Optional[BaseException] = None) -> None:
        db = g.pop("db", None)
        if db is not None:
            db.close()

    @app.context_processor
    def inject_user():
        return {"current_email": session.get("email")}

    @app.before_request
    def require_login():
        if request.endpoint in _PUBLIC_ENDPOINTS:
            return None
        uid = session.get("user_id")
        if uid is None:
            return redirect(url_for("login"))
        # Presence isn't enough — the row must still exist. A stale cookie (e.g.
        # the user's row was deleted) would otherwise pass and then crash the
        # first FK insert. Drop the orphaned session and make them re-auth.
        if get_db().get_user(uid) is None:
            session.clear()
            return redirect(url_for("login"))
        # Validated for the rest of the request — handlers read g.user_id
        # instead of indexing the session directly.
        g.user_id = int(uid)
        return None

    # ---- auth -----------------------------------------------------------

    @app.route("/login")
    def login():
        if session.get("user_id"):
            return redirect(url_for("console"))
        return render_template("login.html", google_oauth=settings.google_oauth_configured())

    @app.route("/auth/google")
    def auth_google():
        if not settings.google_oauth_configured():
            abort(500, "Google OAuth not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")
        flow = build_flow(SIGNIN_SCOPES)
        url, state = flow.authorization_url(
            access_type="online", include_granted_scopes="true", prompt="select_account"
        )
        session["oauth_state"] = state
        session["oauth_action"] = "login"
        return redirect(url)

    @app.route("/gmail/connect")
    def gmail_connect():
        if not settings.google_oauth_configured():
            abort(500, "Google OAuth not configured.")
        flow = build_flow(GMAIL_SCOPES)
        url, state = flow.authorization_url(
            access_type="offline", include_granted_scopes="true", prompt="consent"
        )
        session["oauth_state"] = state
        session["oauth_action"] = "connect_gmail"
        return redirect(url)

    @app.route("/oauth/google/callback")
    def oauth_callback():
        state = session.pop("oauth_state", None)
        action = session.pop("oauth_action", None)
        if request.args.get("error"):
            abort(400, f"Google returned: {request.args.get('error')}")
        if not state or request.args.get("state") != state:
            abort(400, "OAuth state mismatch — please try again.")
        # Require an explicit action set by the route that started the flow —
        # never default to "login", which would mask a bug and could process a
        # connect-Gmail callback as a sign-in.
        if action not in ("login", "connect_gmail"):
            abort(400, "Unknown OAuth action — please restart from the sign-in page.")

        scopes = GMAIL_SCOPES if action == "connect_gmail" else SIGNIN_SCOPES
        flow = build_flow(scopes, state=state)
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        info = userinfo_from_credentials(creds)

        db = get_db()
        if action == "connect_gmail":
            uid = session.get("user_id")
            if uid is None or db.get_user(uid) is None:
                # No live user behind the session — don't attempt an insert
                # that would violate the stream→user FK; re-auth instead.
                session.clear()
                return redirect(url_for("login"))
            config = MailAccountConfig(
                provider=MailProvider.GMAIL_API,
                auth=AuthConfig(
                    method=AuthMethod.OAUTH2,
                    client_config_json=client_config_json(),
                    token_json=creds.to_json(),
                ),
            )
            db.upsert_stream(
                f"gmail:{info['email']}", "email", config.model_dump_json(),
                user_id=uid,
            )
        else:
            user = db.upsert_user(info["sub"], info["email"], info.get("name"))
            session["user_id"] = int(user["id"])
            session["email"] = user["email"]
        return redirect(url_for("console"))

    @app.route("/logout", methods=["POST"])
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---- console --------------------------------------------------------

    @app.route("/", methods=["GET", "POST"])
    def console():
        uid = g.user_id
        db = get_db()
        if request.method == "POST":
            db.set_user_criteria(uid, request.form.get("criteria", ""))
            return redirect(url_for("console", saved=1))
        user = db.get_user(uid) or {}
        inboxes = _inbox_view_rows(db.list_streams_for_user(uid))
        return render_template(
            "console.html",
            inboxes=inboxes,
            criteria=(user.get("criteria") or _default_criteria()),
            telegram_linked=bool(user.get("telegram_chat_id")),
            telegram_bot_username=settings.TELEGRAM_BOT_USERNAME,
            google_oauth=settings.google_oauth_configured(),
            saved=request.args.get("saved") == "1",
        )

    @app.route("/inbox/connect", methods=["GET", "POST"])
    def connect_inbox():
        providers = _imap_provider_presets()
        if request.method == "POST":
            form = request.form
            preset_key = form.get("preset", "custom")
            preset = providers.get(preset_key) or providers["custom"]

            name = form.get("name", "").strip()
            username = form.get("username", "").strip()
            password = form.get("password", "")
            server = (form.get("server", "").strip() or preset["server"]).strip()
            port_str = form.get("port", "").strip() or str(preset["port"])

            errors: List[str] = []
            if not name:
                errors.append("Pick a name for this inbox.")
            if not username:
                errors.append("Email address is required.")
            if not password:
                errors.append("App password is required.")
            if not server:
                errors.append("IMAP server is required.")
            try:
                port = int(port_str)
            except ValueError:
                errors.append(f"Port must be a number (got {port_str!r}).")
                port = 993

            db = get_db()
            if name and db.get_stream(name):
                errors.append(f"You already have an inbox named {name!r}. Pick a different name.")
            if not errors:
                probe = probe_imap(server, port, username, password)
                if not probe.ok:
                    errors.append(probe.error or "Connection failed.")
            if not errors:
                config = MailAccountConfig(
                    provider=MailProvider.IMAP,
                    server=server,
                    port=port,
                    auth=AuthConfig(
                        method=AuthMethod.PASSWORD,
                        username=username,
                        password=password,
                    ),
                    settings=AccountSettings(),
                )
                db.upsert_stream(name, "email", config.model_dump_json(), user_id=g.user_id)
                return redirect(url_for("console"))

            return render_template(
                "new_email_stream.html",
                providers=providers,
                errors=errors,
                form={
                    "preset": preset_key,
                    "name": name,
                    "username": username,
                    "server": server,
                    "port": port_str,
                },
            )

        return render_template(
            "new_email_stream.html",
            providers=providers,
            errors=[],
            form={"preset": "gmail", "name": "", "username": "", "server": "", "port": ""},
        )

    @app.route("/inbox/<name>/delete", methods=["POST"])
    def delete_inbox(name: str):
        db = get_db()
        row = db.get_stream(name)
        # Only let a user delete their own inbox.
        if row and row.get("user_id") == g.user_id:
            db.delete_stream(name)
        return redirect(url_for("console"))

    @app.route("/telegram/link", methods=["POST"])
    def telegram_link():
        if not settings.TELEGRAM_BOT_USERNAME:
            abort(500, "TELEGRAM_BOT_USERNAME not configured")
        token = secrets.token_urlsafe(24)
        get_db().create_telegram_link_token(token, utc_now() + timedelta(minutes=10), g.user_id)
        return redirect(f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={token}")

    @app.route("/telegram/unlink", methods=["POST"])
    def telegram_unlink():
        get_db().set_user_telegram_chat_id(g.user_id, None)
        return redirect(url_for("console"))

    return app


def _maybe_start_embedded_monitor(app: Flask) -> None:
    import os

    if os.getenv("SENTINEL_EMBED_WORKER", "true").strip().lower() not in ("1", "true", "yes", "on"):
        logger.info("SENTINEL_EMBED_WORKER off; web will not run the supervisor (use sentinel-worker).")
        return
    if not settings.LLM_API_KEY:
        logger.info("LLM_API_KEY not configured; skipping embedded supervisor.")
        return
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    def _run_monitor() -> None:
        try:
            db = Database(app.config["DATABASE_URL"])
            asyncio.run(Monitor(db).run())
        except Exception as exc:
            logger.exception("Embedded supervisor crashed: %s", exc)

    threading.Thread(target=_run_monitor, name="sentinel-worker", daemon=True).start()


def _inbox_view_rows(streams: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Shape stored stream rows into what the console template renders
    (enabled flag + a human-readable detail line), tolerating bad config."""
    rows: List[Dict[str, Any]] = []
    for row in streams:
        entry: Dict[str, Any] = {
            "name": row["name"],
            "stream_type": row["stream_type"],
            "enabled": True,
            "detail": "",
            "error": None,
        }
        try:
            if row["stream_type"] == "email":
                cfg = MailAccountConfig.model_validate_json(row["config_json"])
                entry["enabled"] = cfg.enabled
                entry["detail"] = (
                    f"{cfg.auth.username}@{cfg.server}"
                    if cfg.provider in (MailProvider.IMAP, "imap")
                    else str(cfg.provider)
                )
        except Exception as exc:
            entry["error"] = str(exc)
            entry["enabled"] = False
        rows.append(entry)
    return rows


def _imap_provider_presets() -> Dict[str, Dict[str, Any]]:
    return {
        "gmail": {
            "label": "Gmail",
            "server": "imap.gmail.com",
            "port": 993,
            "app_password_url": "https://myaccount.google.com/apppasswords",
            "note": "2-Step Verification must be enabled on your Google account before app passwords are available.",
        },
        "icloud": {
            "label": "iCloud",
            "server": "imap.mail.me.com",
            "port": 993,
            "app_password_url": "https://appleid.apple.com",
            "note": "Apple ID → Sign-In and Security → App-Specific Passwords.",
        },
        "fastmail": {
            "label": "Fastmail",
            "server": "imap.fastmail.com",
            "port": 993,
            "app_password_url": "https://app.fastmail.com/settings/security",
            "note": "Settings → Password & Security → New app password.",
        },
        "outlook": {
            "label": "Outlook.com",
            "server": "outlook.office365.com",
            "port": 993,
            "app_password_url": "https://account.microsoft.com/security",
            "note": "Consumer outlook.com accounts only. Enterprise Microsoft 365 tenants require OAuth, which isn't supported yet.",
        },
        "yahoo": {
            "label": "Yahoo",
            "server": "imap.mail.yahoo.com",
            "port": 993,
            "app_password_url": "https://login.yahoo.com/account/security",
            "note": "Account security → Generate app password.",
        },
        "custom": {
            "label": "Custom IMAP server",
            "server": "",
            "port": 993,
            "app_password_url": "",
            "note": "Enter the IMAP server hostname and port yourself.",
        },
    }


def run(host: str = "127.0.0.1", port: int = 8765, debug: bool = False) -> None:
    app = create_app(debug=debug)
    app.run(host=host, port=port, debug=debug)


def main() -> None:
    run()


if __name__ == "__main__":
    main()
