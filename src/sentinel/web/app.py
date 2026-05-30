"""Sentinel web console.

A thin control panel for the runtime: connect an inbox, edit the classification
criteria, and link a notification channel. It deliberately does NOT display email
content — alerts are delivered out-of-band (Telegram), and the inbox lives in
the user's own mail client.
"""

from __future__ import annotations

import asyncio
import secrets
import threading
from datetime import timedelta
from typing import Any, Dict, List, Optional

from flask import Flask, abort, redirect, render_template, request, url_for

from sentinel.logging_config import get_logger
from sentinel.classifier.openai_classifier import _default_criteria
from sentinel.streams.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel.time_utils import utc_now
from sentinel.config import settings
from sentinel.database import Database
from sentinel.monitor import Monitor
from sentinel.services.preferences import PreferencesService
from sentinel.services.streams import StreamService
from sentinel.web.imap_probe import probe_imap

logger = get_logger(__name__)


def create_app(database_url: Optional[str] = None, debug: bool = False) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.debug = debug
    app.config["DATABASE_URL"] = database_url or settings.require_database_url()
    app.secret_key = settings.SESSION_SECRET or "sentinel-local"
    _maybe_start_embedded_monitor(app)

    def open_db() -> Database:
        return Database(app.config["DATABASE_URL"])

    @app.context_processor
    def inject_runtime_context():
        return {"identity_enabled": False, "current_user": {"email": "local@sentinel"}}

    @app.route("/", methods=["GET", "POST"])
    def console():
        db = open_db()
        try:
            prefs_service = PreferencesService(db)
            if request.method == "POST":
                prefs_service.save_classification_notes(request.form.get("criteria", ""))
                return redirect(url_for("console", saved=1))
            inboxes = StreamService(db).list_stream_rows()
            prefs = prefs_service.load()
        finally:
            db.close()
        return render_template(
            "console.html",
            inboxes=inboxes,
            criteria=prefs.CLASSIFICATION_NOTES or _default_criteria(),
            telegram_linked=bool(prefs.TELEGRAM_CHAT_ID),
            telegram_bot_username=settings.TELEGRAM_BOT_USERNAME,
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

            db = open_db()
            try:
                service = StreamService(db)
                if name and service.get_stream(name):
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
                    service.add_stream(name, "email", config.model_dump_json())
                    return redirect(url_for("console"))
            finally:
                db.close()

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
        db = open_db()
        try:
            StreamService(db).delete_stream(name)
        finally:
            db.close()
        return redirect(url_for("console"))

    @app.route("/telegram/link", methods=["POST"])
    def telegram_link():
        if not settings.TELEGRAM_BOT_USERNAME:
            abort(500, "TELEGRAM_BOT_USERNAME not configured")
        token = secrets.token_urlsafe(24)
        db = open_db()
        try:
            db.create_telegram_link_token(token, utc_now() + timedelta(minutes=10))
        finally:
            db.close()
        return redirect(f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={token}")

    @app.route("/telegram/unlink", methods=["POST"])
    def telegram_unlink():
        db = open_db()
        try:
            PreferencesService(db).clear_telegram_chat_id()
        finally:
            db.close()
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
    # Under Werkzeug's reloader only the child (WERKZEUG_RUN_MAIN=true) should
    # start the supervisor, else two Telegram pollers collide (HTTP 409).
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    def _run_monitor() -> None:
        try:
            db = Database(app.config["DATABASE_URL"])
            asyncio.run(Monitor(db).run())
        except Exception as exc:
            logger.exception("Embedded supervisor crashed: %s", exc)

    threading.Thread(target=_run_monitor, name="sentinel-worker", daemon=True).start()


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
