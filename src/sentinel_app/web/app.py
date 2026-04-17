"""Flask web app — works in both local single-user and hosted multi-tenant modes.

Auth is delegated to a pluggable IdentityProvider (see web/auth/). The rest of
this module is mode-agnostic: every route asks the provider for the current
user_id and scopes its db queries by that id. In local mode the provider is a
null-auth singleton; in hosted mode it's Google OAuth.

Operator-level settings (LLM key, Resend, etc.) are NOT editable via this UI
— the operator configures them via `sentinel init` at deploy time. End users
only see their own preferences.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import (
    Flask,
    abort,
    current_app,
    redirect,
    render_template,
    request,
    url_for,
)

from sentinel_core.config import Settings, settings
from sentinel_core.database import EmailDatabase
from sentinel_core.streams.email.mail_config import (
    AccountSettings,
    AuthConfig,
    AuthMethod,
    MailAccountConfig,
    MailProvider,
)
from sentinel_app.web.auth import build_provider
from sentinel_app.web.imap_probe import probe_imap


def create_app(db_path: Optional[str] = None) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["DB_PATH"] = db_path or settings.DATABASE_PATH
    _bootstrap_settings(app)

    identity = build_provider(Settings.DEPLOYMENT_MODE, app.config["DB_PATH"])
    identity.init_app(app)
    app.extensions["identity"] = identity

    def open_db() -> EmailDatabase:
        return EmailDatabase(app.config["DB_PATH"])

    @app.context_processor
    def inject_identity():
        ident = current_app.extensions["identity"]
        uid = ident.current_user_id()
        return {
            "identity_enabled": ident.is_enabled(),
            "current_user": (
                {"id": uid, "email": ident.current_user_email()} if uid else None
            ),
        }

    # ------------------------------------------------------------------ dashboard

    @app.route("/")
    @identity.login_required
    def dashboard():
        uid = identity.current_user_id()
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
    @identity.login_required
    def preferences_page():
        uid = identity.current_user_id()
        db = open_db()
        try:
            if request.method == "POST":
                raw = request.form.get("EMAIL_NOTIFICATION_TO", "").strip()
                if raw:
                    db.set_user_setting(uid, "EMAIL_NOTIFICATION_TO", raw)
                else:
                    db.delete_user_setting(uid, "EMAIL_NOTIFICATION_TO")
                return redirect(url_for("preferences_page", saved=1))

            stored = db.get_all_user_settings(uid)
            return render_template(
                "preferences.html",
                telegram_chat_id=stored.get("TELEGRAM_CHAT_ID", ""),
                telegram_bot_username=Settings.TELEGRAM_BOT_USERNAME,
                email_notification_to=stored.get("EMAIL_NOTIFICATION_TO", ""),
                saved=request.args.get("saved") == "1",
            )
        finally:
            db.close()

    @app.route("/preferences/telegram/link", methods=["POST"])
    @identity.login_required
    def telegram_link_start():
        uid = identity.current_user_id()
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
    @identity.login_required
    def telegram_unlink():
        uid = identity.current_user_id()
        db = open_db()
        try:
            db.delete_user_setting(uid, "TELEGRAM_CHAT_ID")
        finally:
            db.close()
        return redirect(url_for("preferences_page"))

    # ------------------------------------------------------------------ prompt (per-user)

    @app.route("/prompt", methods=["GET", "POST"])
    @identity.login_required
    def prompt_page():
        uid = identity.current_user_id()
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

    @app.route("/accounts/new", methods=["GET", "POST"])
    @identity.login_required
    def new_account_page():
        uid = identity.current_user_id()
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
                errors.append("Pick a friendly name for this account.")
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

            db = open_db()
            try:
                if name and db.get_account(uid, name):
                    errors.append(
                        f"You already have an account named {name!r}. Pick a different name."
                    )

                if not errors:
                    probe = probe_imap(server, port, username, password)
                    if not probe.ok:
                        errors.append(probe.error or "Connection failed.")

                if errors:
                    return render_template(
                        "new_account.html",
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
                db.upsert_account(uid, name, config.model_dump_json())
            finally:
                db.close()
            return redirect(url_for("accounts_page"))

        return render_template(
            "new_account.html",
            providers=providers,
            errors=[],
            form={"preset": "gmail", "name": "", "username": "", "server": "", "port": ""},
        )

    @app.route("/accounts")
    @identity.login_required
    def accounts_page():
        uid = identity.current_user_id()
        db = open_db()
        try:
            rows = []
            for name, raw in db.list_accounts(uid).items():
                try:
                    acc = MailAccountConfig.model_validate_json(raw)
                    rows.append({"name": name, "provider": acc.provider, "enabled": acc.enabled})
                except Exception as e:
                    rows.append(
                        {"name": name, "provider": "invalid", "enabled": False, "error": str(e)}
                    )
            return render_template("accounts.html", accounts=rows)
        finally:
            db.close()

    @app.route("/accounts/<name>/toggle", methods=["POST"])
    @identity.login_required
    def toggle_account(name: str):
        uid = identity.current_user_id()
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
    @identity.login_required
    def delete_account(name: str):
        uid = identity.current_user_id()
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
    """Load Settings from the DB so the chosen IdentityProvider can read them."""
    db = EmailDatabase(app.config["DB_PATH"])
    try:
        Settings.load(db)
    finally:
        db.close()


def _daemon_health(last_check: Optional[datetime]) -> Dict[str, Any]:
    if last_check is None:
        return {"status": "never run", "ok": False}
    age_s = (datetime.now() - last_check).total_seconds()
    threshold = max(3 * Settings.POLL_INTERVAL_SECONDS, 60)
    if age_s < threshold:
        return {"status": f"running (last check {int(age_s)}s ago)", "ok": True}
    return {"status": f"stale (last check {int(age_s)}s ago)", "ok": False}


def _fetch_recent_processed(
    db: EmailDatabase, user_id: int, limit: int = 25
) -> List[Dict[str, Any]]:
    cursor = db.conn.execute(
        "SELECT email_id, provider, subject, sender, processed_at "
        "FROM processed_emails WHERE user_id = ? "
        "ORDER BY processed_at DESC LIMIT ?",
        (user_id, limit),
    )
    return [dict(row) for row in cursor.fetchall()]


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
