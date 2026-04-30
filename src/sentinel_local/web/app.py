"""Local single-user web app."""

from __future__ import annotations

import asyncio
import queue
import secrets
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import Flask, Response, abort, redirect, render_template, request, stream_with_context, url_for

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams import ensure_loaded
from sentinel_lib.streams.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel_lib.streams.rss.config import RSSStreamConfig
from sentinel_lib.time_utils import utc_now
from sentinel_local.config import settings
from sentinel_local.database import LocalDatabase
from sentinel_local.live_bus import LiveEventBus
from sentinel_local.monitor import LocalMonitor
from sentinel_local.services.preferences import LocalPreferencesService
from sentinel_local.services.runtime import LocalRuntimeService
from sentinel_local.services.streams import LocalStreamService
from sentinel_local.web.imap_probe import probe_imap

logger = get_logger(__name__)


def create_app(db_path: Optional[str] = None, debug: bool = False) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.debug = debug
    app.config["DB_PATH"] = db_path or settings.DATABASE_PATH
    _bootstrap_settings(app)
    ensure_loaded()
    app.secret_key = settings.SESSION_SECRET or "sentinel-local"
    app.extensions["live_bus"] = _maybe_start_embedded_monitor(app)

    def open_db() -> LocalDatabase:
        return LocalDatabase(app.config["DB_PATH"])

    @app.context_processor
    def inject_runtime_context():
        return {
            "identity_enabled": False,
            "current_user": {"email": "local@sentinel"},
        }

    @app.route("/")
    def dashboard():
        db = open_db()
        try:
            snapshot = LocalRuntimeService(db).dashboard_snapshot()
        finally:
            db.close()
        return render_template("dashboard.html", **snapshot)

    @app.route("/preferences", methods=["GET", "POST"])
    def preferences_page():
        db = open_db()
        try:
            service = LocalPreferencesService(db)
            if request.method == "POST":
                service.save_email_notification_to(
                    request.form.get("EMAIL_NOTIFICATION_TO", "")
                )
                return redirect(url_for("preferences_page", saved=1))
            prefs = service.load()
        finally:
            db.close()
        return render_template(
            "preferences.html",
            telegram_chat_id=prefs.TELEGRAM_CHAT_ID,
            telegram_bot_username=settings.TELEGRAM_BOT_USERNAME,
            email_notification_to=prefs.EMAIL_NOTIFICATION_TO,
            saved=request.args.get("saved") == "1",
        )

    @app.route("/preferences/telegram/link", methods=["POST"])
    def telegram_link_start():
        if not settings.TELEGRAM_BOT_USERNAME:
            abort(500, "TELEGRAM_BOT_USERNAME not configured")
        token = secrets.token_urlsafe(24)
        expires = utc_now() + timedelta(minutes=10)
        db = open_db()
        try:
            db.create_telegram_link_token(token, expires)
        finally:
            db.close()
        return redirect(f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={token}")

    @app.route("/preferences/telegram/unlink", methods=["POST"])
    def telegram_unlink():
        db = open_db()
        try:
            LocalPreferencesService(db).clear_telegram_chat_id()
        finally:
            db.close()
        return redirect(url_for("preferences_page"))

    @app.route("/prompt", methods=["GET", "POST"])
    def prompt_page():
        db = open_db()
        try:
            service = LocalPreferencesService(db)
            if request.method == "POST":
                service.save_classification_notes(
                    request.form.get("CLASSIFICATION_NOTES", "")
                )
                return redirect(url_for("prompt_page", saved=1))
            notes = service.load().CLASSIFICATION_NOTES
        finally:
            db.close()
        return render_template(
            "prompt.html",
            notes=notes,
            base_prompt=_base_prompt_preview(),
            saved=request.args.get("saved") == "1",
        )

    @app.route("/events/stream")
    def events_stream():
        bus: Optional[LiveEventBus] = app.extensions.get("live_bus")
        last_id_header = request.headers.get("Last-Event-ID")
        since_param = request.args.get("since")
        try:
            if last_id_header is not None:
                cursor = int(last_id_header)
            elif since_param is not None:
                cursor = int(since_param)
            else:
                db = open_db()
                try:
                    cursor = db.latest_live_event_id()
                finally:
                    db.close()
        except (ValueError, TypeError):
            cursor = 0

        generate = _sse_push_loop(app.config["DB_PATH"], cursor, bus) if bus is not None else _sse_poll_loop(app.config["DB_PATH"], cursor)
        return Response(
            stream_with_context(generate)(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    @app.route("/streams")
    def streams_page():
        db = open_db()
        try:
            rows = LocalStreamService(db).list_stream_rows()
        finally:
            db.close()
        return render_template("streams.html", streams=rows)

    @app.route("/streams/new")
    def new_stream_page():
        return render_template("new_stream.html")

    @app.route("/streams/new/email", methods=["GET", "POST"])
    def new_email_stream_page():
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
                errors.append("Pick a friendly name for this stream.")
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
                service = LocalStreamService(db)
                if name and service.get_stream(name):
                    errors.append(
                        f"You already have a stream named {name!r}. Pick a different name."
                    )
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
                    return redirect(url_for("streams_page"))
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

    @app.route("/streams/new/rss", methods=["GET", "POST"])
    def new_rss_stream_page():
        if request.method == "POST":
            name = request.form.get("name", "").strip()
            feed_url = request.form.get("feed_url", "").strip()
            poll_str = request.form.get("poll_seconds", "300").strip()

            errors: List[str] = []
            if not name:
                errors.append("Pick a friendly name for this stream.")
            if not feed_url:
                errors.append("Feed URL is required.")
            try:
                poll_seconds = int(poll_str)
            except ValueError:
                errors.append(f"Poll interval must be a number (got {poll_str!r}).")
                poll_seconds = 300

            db = open_db()
            try:
                service = LocalStreamService(db)
                if name and service.get_stream(name):
                    errors.append(
                        f"You already have a stream named {name!r}. Pick a different name."
                    )
                if not errors:
                    try:
                        config = RSSStreamConfig(feed_url=feed_url, poll_seconds=poll_seconds)
                    except Exception as exc:
                        errors.append(f"Invalid config: {exc}")
                        config = None
                    if config is not None:
                        service.add_stream(name, "rss", config.model_dump_json())
                        return redirect(url_for("streams_page"))
            finally:
                db.close()

            return render_template(
                "new_rss_stream.html",
                errors=errors,
                form={"name": name, "feed_url": feed_url, "poll_seconds": poll_str},
            )

        return render_template(
            "new_rss_stream.html",
            errors=[],
            form={"name": "", "feed_url": "", "poll_seconds": "300"},
        )

    @app.route("/streams/<name>/toggle", methods=["POST"])
    def toggle_stream(name: str):
        db = open_db()
        try:
            LocalStreamService(db).toggle_stream(name)
        finally:
            db.close()
        return redirect(url_for("streams_page"))

    @app.route("/streams/<name>/delete", methods=["POST"])
    def delete_stream(name: str):
        db = open_db()
        try:
            LocalStreamService(db).delete_stream(name)
        finally:
            db.close()
        return redirect(url_for("streams_page"))

    return app


def _bootstrap_settings(app: Flask) -> None:
    db = LocalDatabase(app.config["DB_PATH"])
    try:
        settings.load(db)
    finally:
        db.close()


def _maybe_start_embedded_monitor(app: Flask) -> Optional[LiveEventBus]:
    if not settings.LLM_API_KEY:
        logger.info("LLM_API_KEY not configured; skipping embedded local monitor.")
        return None
    import os

    # Under Werkzeug's reloader the parent process re-execs a child with
    # WERKZEUG_RUN_MAIN=true; the parent itself never sets it. Starting the
    # monitor in both processes spins up two Telegram long-pollers, which
    # Telegram rejects with HTTP 409. Only run in the child (or when the
    # reloader is off entirely).
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return None

    bus = LiveEventBus()

    def _run_monitor() -> None:
        try:
            db = LocalDatabase(app.config["DB_PATH"])
            monitor = LocalMonitor(db, bus=bus)
            asyncio.run(monitor.run())
        except Exception as exc:
            logger.exception("Embedded local monitor crashed: %s", exc)

    threading.Thread(target=_run_monitor, name="sentinel-local-monitor", daemon=True).start()
    return bus


def _sse_push_loop(db_path: str, cursor: int, bus: LiveEventBus):
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        q = bus.subscribe()
        heartbeat_countdown = 30
        try:
            db = LocalDatabase(db_path)
            try:
                while True:
                    rows = db.fetch_live_events_since(cursor, limit=200)
                    if rows:
                        for row in rows:
                            cursor = int(row["id"])
                            yield _sse_frame(cursor, row["event_type"], row["payload_json"])
                        heartbeat_countdown = 30
                        continue

                    try:
                        event = q.get(timeout=0.5)
                    except queue.Empty:
                        heartbeat_countdown -= 1
                        if heartbeat_countdown <= 0:
                            yield ": keepalive\n\n"
                            heartbeat_countdown = 30
                        continue

                    if event.event_id <= cursor:
                        continue
                    cursor = event.event_id
                    yield _sse_frame(cursor, event.event_type, event.payload_json)
                    heartbeat_countdown = 30
            finally:
                db.close()
        finally:
            bus.unsubscribe(q)

    return generate


def _sse_poll_loop(db_path: str, cursor: int):
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        heartbeat_countdown = 30
        db = LocalDatabase(db_path)
        try:
            while True:
                rows = db.fetch_live_events_since(cursor, limit=200)
                if rows:
                    for row in rows:
                        cursor = int(row["id"])
                        yield _sse_frame(cursor, row["event_type"], row["payload_json"])
                    heartbeat_countdown = 30
                else:
                    heartbeat_countdown -= 1
                    if heartbeat_countdown <= 0:
                        yield ": keepalive\n\n"
                        heartbeat_countdown = 30
                time.sleep(0.5)
        finally:
            db.close()

    return generate


def _sse_frame(event_id: int, event_type: str, payload_json: str) -> str:
    return f"id: {event_id}\nevent: {event_type}\ndata: {payload_json}\n\n"


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
        "You are a classification assistant. The user subscribes to several "
        "information streams (email, RSS, ...) and wants to be alerted only to "
        "the items that genuinely matter.\n\n"
        "For emails, IMPORTANT means: addressed to me personally, job interview "
        "offers, legal matters, urgent. NORMAL means everything else.\n\n"
        "For RSS items, IMPORTANT means: major breaking news with real "
        "consequences, security advisories, releases the user cares about."
    )


def run(host: str = "127.0.0.1", port: int = 8765, debug: bool = False) -> None:
    app = create_app(debug=debug)
    app.run(host=host, port=port, debug=debug)


def main() -> None:
    run()
