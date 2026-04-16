"""Flask web app — multi-tenant signup/login + per-user configuration.

Signup/login goes through Google OAuth (identity scopes: openid email
profile — no Gmail access). Users land on a dashboard showing their own
status and classification history, manage their own Telegram / mail
accounts / classification notes, and never see other users' data.

Operator-level settings (LLM key, Resend, etc.) are NOT editable via
this UI — the operator configures them via `sentinel init` at deploy
time. End users only see their own preferences.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta
from functools import wraps
from typing import Any, Callable, Dict, List, Optional

from authlib.integrations.flask_client import OAuth
from flask import (
    Flask,
    abort,
    g,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from sentinel.config import Settings, settings
from sentinel.database import EmailDatabase
from sentinel.email.mail_config import MailAccountConfig
from sentinel.user_settings import UserSettings


GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"


def create_app(db_path: Optional[str] = None) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["DB_PATH"] = db_path or settings.DATABASE_PATH
    _bootstrap_settings(app)

    app.secret_key = Settings.SESSION_SECRET

    oauth = OAuth(app)
    oauth.register(
        name="google",
        client_id=Settings.GOOGLE_CLIENT_ID,
        client_secret=Settings.GOOGLE_CLIENT_SECRET,
        server_metadata_url=GOOGLE_DISCOVERY_URL,
        client_kwargs={"scope": "openid email profile"},
    )

    def open_db() -> EmailDatabase:
        return EmailDatabase(app.config["DB_PATH"])

    def current_user_id() -> Optional[int]:
        return session.get("user_id")

    def login_required(view: Callable) -> Callable:
        @wraps(view)
        def wrapped(*args, **kwargs):
            if current_user_id() is None:
                return redirect(url_for("login"))
            return view(*args, **kwargs)
        return wrapped

    @app.context_processor
    def inject_current_user():
        uid = current_user_id()
        if uid is None:
            return {"current_user": None}
        return {"current_user": {"id": uid, "email": session.get("email"), "name": session.get("name")}}

    # ------------------------------------------------------------------ auth

    @app.route("/login")
    def login():
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

        db = open_db()
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

    # ------------------------------------------------------------------ dashboard

    @app.route("/")
    @login_required
    def dashboard():
        uid = current_user_id()
        db = open_db()
        try:
            processed_count = db.get_processed_count(user_id=uid)
            last_check = db.get_last_check_time(uid)
            monitoring_start = db.get_monitoring_start_time(uid)
            recent = _fetch_recent_processed(db, uid, limit=25)
            accounts_count = len(db.list_accounts(uid))
            health = _daemon_health(last_check)
        finally:
            db.close()

        return render_template(
            "dashboard.html",
            processed_count=processed_count,
            last_check=last_check,
            monitoring_start=monitoring_start,
            recent=recent,
            accounts_count=accounts_count,
            health=health,
        )

    # ------------------------------------------------------------------ preferences (per-user)

    @app.route("/preferences", methods=["GET", "POST"])
    @login_required
    def preferences_page():
        uid = current_user_id()
        db = open_db()
        try:
            if request.method == "POST":
                # Only EMAIL_NOTIFICATION_TO is edited via this form now.
                # TELEGRAM_CHAT_ID is populated by the bot linking flow.
                raw = request.form.get("EMAIL_NOTIFICATION_TO", "").strip()
                if raw:
                    db.set_user_setting(uid, "EMAIL_NOTIFICATION_TO", raw)
                else:
                    db.delete_user_setting(uid, "EMAIL_NOTIFICATION_TO")
                return redirect(url_for("preferences_page", saved=1))

            stored = db.get_all_user_settings(uid)
            telegram_chat_id = stored.get("TELEGRAM_CHAT_ID", "")
            return render_template(
                "preferences.html",
                telegram_chat_id=telegram_chat_id,
                telegram_bot_username=Settings.TELEGRAM_BOT_USERNAME,
                email_notification_to=stored.get("EMAIL_NOTIFICATION_TO", ""),
                saved=request.args.get("saved") == "1",
            )
        finally:
            db.close()

    @app.route("/preferences/telegram/link", methods=["POST"])
    @login_required
    def telegram_link_start():
        """Generate a one-shot linking token and redirect to the bot's deep link."""
        uid = current_user_id()
        if not Settings.TELEGRAM_BOT_USERNAME:
            abort(500, "TELEGRAM_BOT_USERNAME not configured")
        token = secrets.token_urlsafe(24)
        expires = datetime.now() + timedelta(minutes=10)
        db = open_db()
        try:
            db.create_telegram_link_token(uid, token, expires)
        finally:
            db.close()
        return redirect(
            f"https://t.me/{Settings.TELEGRAM_BOT_USERNAME}?start={token}"
        )

    @app.route("/preferences/telegram/unlink", methods=["POST"])
    @login_required
    def telegram_unlink():
        uid = current_user_id()
        db = open_db()
        try:
            db.delete_user_setting(uid, "TELEGRAM_CHAT_ID")
        finally:
            db.close()
        return redirect(url_for("preferences_page"))

    # ------------------------------------------------------------------ prompt (per-user)

    @app.route("/prompt", methods=["GET", "POST"])
    @login_required
    def prompt_page():
        uid = current_user_id()
        db = open_db()
        try:
            if request.method == "POST":
                notes = request.form.get("CLASSIFICATION_NOTES", "")
                if notes.strip():
                    db.set_user_setting(uid, "CLASSIFICATION_NOTES", notes)
                else:
                    db.delete_user_setting(uid, "CLASSIFICATION_NOTES")
                return redirect(url_for("prompt_page", saved=1))

            notes = db.get_user_setting(uid, "CLASSIFICATION_NOTES") or ""
            return render_template(
                "prompt.html",
                notes=notes,
                base_prompt=_base_prompt_preview(),
                saved=request.args.get("saved") == "1",
            )
        finally:
            db.close()

    # ------------------------------------------------------------------ accounts (per-user)

    @app.route("/accounts")
    @login_required
    def accounts_page():
        uid = current_user_id()
        db = open_db()
        try:
            rows = []
            for name, raw in db.list_accounts(uid).items():
                try:
                    acc = MailAccountConfig.model_validate_json(raw)
                    rows.append({"name": name, "provider": acc.provider, "enabled": acc.enabled})
                except Exception as e:
                    rows.append({"name": name, "provider": "invalid", "enabled": False, "error": str(e)})
            return render_template("accounts.html", accounts=rows)
        finally:
            db.close()

    @app.route("/accounts/<name>/toggle", methods=["POST"])
    @login_required
    def toggle_account(name: str):
        uid = current_user_id()
        db = open_db()
        try:
            raw = db.get_account(uid, name)
            if not raw:
                abort(404)
            data = json.loads(raw)
            data["enabled"] = not data.get("enabled", True)
            db.upsert_account(uid, name, json.dumps(data))
            return redirect(url_for("accounts_page"))
        finally:
            db.close()

    @app.route("/accounts/<name>/delete", methods=["POST"])
    @login_required
    def delete_account(name: str):
        uid = current_user_id()
        db = open_db()
        try:
            if not db.get_account(uid, name):
                abort(404)
            db.delete_account(uid, name)
            return redirect(url_for("accounts_page"))
        finally:
            db.close()

    return app


# ------------------------------------------------------------------ helpers

def _bootstrap_settings(app: Flask) -> None:
    """Load Settings from the DB once at app creation time so OAuth / session
    config is available to Authlib and Flask."""
    db = EmailDatabase(app.config["DB_PATH"])
    try:
        Settings.load(db)
        if not Settings.SESSION_SECRET:
            raise RuntimeError(
                "SESSION_SECRET not configured. Run 'sentinel init' first."
            )
        if not Settings.GOOGLE_CLIENT_ID or not Settings.GOOGLE_CLIENT_SECRET:
            raise RuntimeError(
                "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured. Run 'sentinel init' first."
            )
    finally:
        db.close()


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 6:
        return "•" * len(value)
    return "•" * (len(value) - 4) + value[-4:]


def _daemon_health(last_check: Optional[datetime]) -> Dict[str, Any]:
    if last_check is None:
        return {"status": "never run", "ok": False}
    age_s = (datetime.now() - last_check).total_seconds()
    threshold = max(3 * Settings.POLL_INTERVAL_SECONDS, 60)
    if age_s < threshold:
        return {"status": f"running (last check {int(age_s)}s ago)", "ok": True}
    return {"status": f"stale (last check {int(age_s)}s ago)", "ok": False}


def _fetch_recent_processed(db: EmailDatabase, user_id: int, limit: int = 25) -> List[Dict[str, Any]]:
    cursor = db.conn.execute(
        "SELECT email_id, provider, subject, sender, processed_at "
        "FROM processed_emails WHERE user_id = ? "
        "ORDER BY processed_at DESC LIMIT ?",
        (user_id, limit),
    )
    return [dict(row) for row in cursor.fetchall()]


def _base_prompt_preview() -> str:
    return (
        "You are an email classification assistant. "
        "Analyze the following email and classify it as IMPORTANT or NORMAL.\n\n"
        "IMPORTANT:\n"
        "- Addressed to me personally\n"
        "- Job interview offer\n"
        "- Legal matter\n"
        "- Urgent\n\n"
        "NORMAL:\n"
        "- Everything else, including newsletters, mass mailings, and apparent scams"
    )


def run(host: str = "127.0.0.1", port: int = 8765, debug: bool = False) -> None:
    app = create_app()
    app.run(host=host, port=port, debug=debug)
