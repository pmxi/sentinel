"""Flask web app — works in both local single-user and hosted multi-tenant modes.

Auth is delegated to a pluggable IdentityProvider (see web/auth/). The rest of
this module is mode-agnostic: every route asks the provider for the current
user_id and scopes its db queries by that id.

Operator-level settings (LLM key, Resend, etc.) are NOT editable via this UI
— the operator configures them via `sentinel init` at deploy time. End users
only see their own streams and preferences.
"""

from __future__ import annotations

import asyncio
import json
import queue
import secrets
import threading
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import time

from flask import (
    Flask,
    Response,
    abort,
    current_app,
    redirect,
    render_template,
    request,
    stream_with_context,
    url_for,
)

from sentinel_core.config import Settings, settings
from sentinel_core.database import EmailDatabase
from sentinel_core.live_bus import LiveEventBus
from sentinel_core.logging_config import get_logger
from sentinel_core.monitor import Monitor
from sentinel_core.streams.email.mail_config import (
    AccountSettings,
    AuthConfig,
    AuthMethod,
    MailAccountConfig,
    MailProvider,
)
from sentinel_core.streams.registry import all_specs, ensure_loaded
from sentinel_core.streams.rss.config import RSSStreamConfig
from sentinel_core.time_utils import utc_now
from sentinel_app.web.auth import build_provider
from sentinel_app.web.imap_probe import probe_imap

logger = get_logger(__name__)


def create_app(db_path: Optional[str] = None) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["DB_PATH"] = db_path or settings.DATABASE_PATH
    _bootstrap_settings(app)
    ensure_loaded()

    identity = build_provider(Settings.DEPLOYMENT_MODE, app.config["DB_PATH"])
    identity.init_app(app)
    app.extensions["identity"] = identity

    # In local (single-user, single-process) mode, run the supervisor in a
    # background thread so there's only one command to start Sentinel and
    # the live feed can fan out events in-memory with zero polling.
    #
    # Hosted mode intentionally keeps the supervisor as a separate process
    # (isolation, multi-worker web servers, scale-out) — the SSE handler
    # falls back to tailing the live_events table in sqlite.
    app.extensions["live_bus"] = _maybe_start_embedded_monitor(app)

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
            recent = db.recent_processed_items(uid, limit=25)
            streams_count = len(db.list_streams(uid))
            health = _daemon_health(last_check)
        finally:
            db.close()

        return render_template(
            "dashboard.html",
            processed_count=processed_count,
            last_check=last_check,
            monitoring_start=monitoring_start,
            recent=recent,
            streams_count=streams_count,
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
        expires = utc_now() + timedelta(minutes=10)
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

    # ------------------------------------------------------------------ live feed (SSE)

    @app.route("/events/stream")
    @identity.login_required
    def events_stream():
        uid = identity.current_user_id()
        bus: Optional[LiveEventBus] = app.extensions.get("live_bus")

        # Start from the latest id so a new connection doesn't replay an
        # hour of history. Client passes Last-Event-ID on reconnect to
        # resume without gaps.
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
                    cursor = db.latest_live_event_id(uid)
                finally:
                    db.close()
        except (ValueError, TypeError):
            cursor = 0

        if bus is not None:
            generate = _sse_push_loop(app.config["DB_PATH"], uid, cursor, bus)
        else:
            generate = _sse_poll_loop(app.config["DB_PATH"], uid, cursor)

        return Response(
            stream_with_context(generate)(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    # ------------------------------------------------------------------ streams (per-user)

    @app.route("/streams")
    @identity.login_required
    def streams_page():
        uid = identity.current_user_id()
        db = open_db()
        try:
            rows = []
            for row in db.list_streams(uid):
                entry = {
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
                    elif row["stream_type"] == "rss":
                        cfg = RSSStreamConfig.model_validate_json(row["config_json"])
                        entry["enabled"] = cfg.enabled
                        entry["detail"] = str(cfg.feed_url)
                except Exception as e:
                    entry["error"] = str(e)
                    entry["enabled"] = False
                rows.append(entry)
            return render_template("streams.html", streams=rows)
        finally:
            db.close()

    @app.route("/streams/new")
    @identity.login_required
    def new_stream_page():
        return render_template(
            "new_stream.html",
            stream_specs=all_specs(),
        )

    @app.route("/streams/new/email", methods=["GET", "POST"])
    @identity.login_required
    def new_email_stream_page():
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
                if name and db.get_stream(uid, name):
                    errors.append(
                        f"You already have a stream named {name!r}. Pick a different name."
                    )

                if not errors:
                    probe = probe_imap(server, port, username, password)
                    if not probe.ok:
                        errors.append(probe.error or "Connection failed.")

                if errors:
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
                db.upsert_stream(uid, name, "email", config.model_dump_json())
            finally:
                db.close()
            return redirect(url_for("streams_page"))

        return render_template(
            "new_email_stream.html",
            providers=providers,
            errors=[],
            form={"preset": "gmail", "name": "", "username": "", "server": "", "port": ""},
        )

    @app.route("/streams/new/rss", methods=["GET", "POST"])
    @identity.login_required
    def new_rss_stream_page():
        uid = identity.current_user_id()

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
                if name and db.get_stream(uid, name):
                    errors.append(
                        f"You already have a stream named {name!r}. Pick a different name."
                    )
                if not errors:
                    try:
                        config = RSSStreamConfig(
                            feed_url=feed_url, poll_seconds=poll_seconds
                        )
                    except Exception as e:
                        errors.append(f"Invalid config: {e}")
                        config = None

                if errors or config is None:
                    return render_template(
                        "new_rss_stream.html",
                        errors=errors,
                        form={
                            "name": name,
                            "feed_url": feed_url,
                            "poll_seconds": poll_str,
                        },
                    )

                db.upsert_stream(uid, name, "rss", config.model_dump_json())
            finally:
                db.close()
            return redirect(url_for("streams_page"))

        return render_template(
            "new_rss_stream.html",
            errors=[],
            form={"name": "", "feed_url": "", "poll_seconds": "300"},
        )

    @app.route("/streams/<name>/toggle", methods=["POST"])
    @identity.login_required
    def toggle_stream(name: str):
        uid = identity.current_user_id()
        db = open_db()
        try:
            row = db.get_stream(uid, name)
            if not row:
                abort(404)
            data = json.loads(row["config_json"])
            data["enabled"] = not data.get("enabled", True)
            db.upsert_stream(uid, name, row["stream_type"], json.dumps(data))
            return redirect(url_for("streams_page"))
        finally:
            db.close()

    @app.route("/streams/<name>/delete", methods=["POST"])
    @identity.login_required
    def delete_stream(name: str):
        uid = identity.current_user_id()
        db = open_db()
        try:
            if not db.get_stream(uid, name):
                abort(404)
            db.delete_stream(uid, name)
            return redirect(url_for("streams_page"))
        finally:
            db.close()

    return app


# ------------------------------------------------------------------ helpers

def _bootstrap_settings(app: Flask) -> None:
    db = EmailDatabase(app.config["DB_PATH"])
    try:
        Settings.load(db)
    finally:
        db.close()


def _maybe_start_embedded_monitor(app: Flask) -> Optional[LiveEventBus]:
    """Start the supervisor in-process for local mode. Returns the shared
    bus, or None if this process shouldn't run a monitor."""
    if Settings.DEPLOYMENT_MODE != "local":
        return None
    if not Settings.LLM_API_KEY:
        logger.info(
            "LLM_API_KEY not configured — skipping embedded monitor. "
            "Run `sentinel init --local` to configure."
        )
        return None
    # Werkzeug's reloader spawns two processes; only the reloaded child
    # should run the supervisor (it's the one that survives across restarts).
    import os
    if os.environ.get("WERKZEUG_RUN_MAIN") == "false":
        return None

    bus = LiveEventBus()

    def _run_monitor() -> None:
        try:
            db = EmailDatabase(app.config["DB_PATH"])
            monitor = Monitor(db, bus=bus)
            asyncio.run(monitor.run())
        except Exception as e:
            logger.exception(f"Embedded monitor crashed: {e}")

    thread = threading.Thread(
        target=_run_monitor, name="sentinel-monitor", daemon=True
    )
    thread.start()
    logger.info("Embedded monitor started in background thread")
    return bus


def _sse_push_loop(db_path: str, uid: int, cursor: int, bus: LiveEventBus):
    """Generator factory for the local-mode SSE: subscribe first (so nothing
    published after this point is missed), replay any catch-up events from
    the db, then block on the bus queue. Zero polling after the initial
    catch-up."""
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        q = bus.subscribe()
        try:
            db = EmailDatabase(db_path)
            try:
                for row in db.fetch_live_events_since(uid, cursor, limit=500):
                    cursor = int(row["id"])
                    yield _sse_frame(cursor, row["event_type"], row["payload_json"])
            finally:
                db.close()

            while True:
                try:
                    event = q.get(timeout=15)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                if event.user_id != uid:
                    continue
                if event.event_id <= cursor:
                    continue
                cursor = event.event_id
                yield _sse_frame(cursor, event.event_type, event.payload_json)
        finally:
            bus.unsubscribe(q)
    return generate


def _sse_poll_loop(db_path: str, uid: int, cursor: int):
    """Generator factory for the hosted-mode SSE: tail the live_events
    table every 500ms."""
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        heartbeat_countdown = 30
        db = EmailDatabase(db_path)
        try:
            while True:
                rows = db.fetch_live_events_since(uid, cursor, limit=200)
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


def _daemon_health(last_check: Optional[datetime]) -> Dict[str, Any]:
    if last_check is None:
        return {"status": "never run", "ok": False}
    age_s = (utc_now() - last_check).total_seconds()
    threshold = max(3 * 60, 60)  # consider the daemon stale after ~3 minutes
    if age_s < threshold:
        return {"status": f"running (last check {int(age_s)}s ago)", "ok": True}
    return {"status": f"stale (last check {int(age_s)}s ago)", "ok": False}


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
    app = create_app()
    app.run(host=host, port=port, debug=debug)
