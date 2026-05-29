"""Local single-user web app."""

from __future__ import annotations

import asyncio
import json
import queue
import secrets
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import Flask, Response, abort, redirect, render_template, request, stream_with_context, url_for

from sentinel.core.logging_config import get_logger
from sentinel.core.streams import ensure_loaded
from sentinel.core.streams.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel.core.time_utils import utc_now
from sentinel.local.config import settings
from sentinel.local.database import LocalDatabase
from sentinel.local.live_bus import LiveEventBus
from sentinel.local.monitor import LocalMonitor
from sentinel.local.services.preferences import LocalPreferencesService
from sentinel.local.services.runtime import LocalRuntimeService
from sentinel.local.services.streams import LocalStreamService
from sentinel.local.web.imap_probe import probe_imap

logger = get_logger(__name__)


def create_app(database_url: Optional[str] = None, debug: bool = False) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.debug = debug
    app.config["DATABASE_URL"] = database_url or settings.require_database_url()
    _bootstrap_settings(app)
    ensure_loaded()
    app.secret_key = settings.SESSION_SECRET or "sentinel-local"
    app.extensions["live_bus"] = _maybe_start_embedded_monitor(app)

    def open_db() -> LocalDatabase:
        return LocalDatabase(app.config["DATABASE_URL"])

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
                    cursor = db.latest_event_id()
                finally:
                    db.close()
        except (ValueError, TypeError):
            cursor = 0

        generate = (
            _sse_push_loop(app.config["DATABASE_URL"], cursor, bus)
            if bus is not None
            else _sse_poll_loop(app.config["DATABASE_URL"], cursor)
        )
        return Response(
            stream_with_context(generate)(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    @app.route("/live")
    def live_page():
        """Real-time multi-source traffic monitor."""
        return render_template("live.html")

    @app.route("/alerts")
    def alerts_page():
        """Recent items the classifier flagged as IMPORTANT."""
        try:
            limit = min(max(int(request.args.get("limit", "50")), 5), 500)
        except (TypeError, ValueError):
            limit = 50
        priority_filter = request.args.get("priority", "important")
        if priority_filter not in ("important", "normal", "all"):
            priority_filter = "important"

        db = open_db()
        try:
            with db.conn.cursor() as cur:
                where_pri = "" if priority_filter == "all" else (
                    "AND c.priority = %s"
                )
                params: list[Any] = []
                if priority_filter != "all":
                    params.append(priority_filter)
                params.append(limit)
                cur.execute(
                    f"""
                    SELECT
                        e.id,
                        c.classified_at        AS created_at,
                        c.priority             AS priority,
                        e.source_type          AS source_type,
                        e.stream_name          AS stream_name,
                        e.title                AS title,
                        e.url                  AS url,
                        c.summary              AS summary,
                        c.reasoning            AS reasoning
                    FROM classification c
                    JOIN event e ON e.id = c.event_id
                    WHERE TRUE {where_pri}
                    ORDER BY c.classified_at DESC
                    LIMIT %s
                    """,
                    params,
                )
                rows = cur.fetchall()

                cur.execute(
                    "SELECT priority, COUNT(*) AS c FROM classification GROUP BY 1"
                )
                counts = {
                    (r["priority"] if isinstance(r, dict) else r[0]):
                    (r["c"] if isinstance(r, dict) else r[1])
                    for r in cur.fetchall()
                }
        finally:
            db.close()

        items = [dict(r) if isinstance(r, dict) else {
            "id": r[0], "created_at": r[1], "priority": r[2],
            "source_type": r[3], "stream_name": r[4],
            "title": r[5], "url": r[6], "summary": r[7], "reasoning": r[8],
        } for r in rows]

        return render_template(
            "alerts.html",
            items=items,
            priority_filter=priority_filter,
            limit=limit,
            counts=counts,
        )

    @app.route("/streams/activity")
    def streams_activity():
        """Per-stream emission stats over a recent window.

        Reads the last `window` rows of `live_events` (default 20k) and
        groups item_received events by stream_name. Cheap because the
        outer filter uses live_events' `id` BTREE index — the JSONB
        extraction only runs on the windowed subset.
        """
        try:
            window = min(max(int(request.args.get("window", "20000")), 1000), 200000)
        except (TypeError, ValueError):
            window = 20000

        db = open_db()
        try:
            with db.conn.cursor() as cur:
                cur.execute("SELECT MAX(id) FROM event")
                row = cur.fetchone()
                max_id = (row["max"] if isinstance(row, dict) else row[0]) or 0
                low_id = max(0, max_id - window)
                cur.execute(
                    """
                    SELECT
                        stream_name              AS stream,
                        source_type,
                        MAX(observed_at)         AS last_seen,
                        MIN(observed_at)         AS first_seen,
                        COUNT(*)                 AS n
                    FROM event
                    WHERE id > %s
                    GROUP BY 1, 2
                    ORDER BY n DESC
                    """,
                    (low_id,),
                )
                rows = cur.fetchall()
                cur.execute(
                    "SELECT COUNT(*) AS c FROM event WHERE id > %s", (low_id,),
                )
                total_row = cur.fetchone()
                total = (total_row["c"] if isinstance(total_row, dict) else total_row[0]) or 0
        finally:
            db.close()

        # Compute rate per stream in items/min
        now = utc_now()
        activity: List[Dict[str, Any]] = []
        for r in rows:
            d = r if isinstance(r, dict) else {
                "stream": r[0], "source_type": r[1],
                "last_seen": r[2], "first_seen": r[3], "n": r[4],
            }
            first = d["first_seen"]
            last = d["last_seen"]
            window_secs = max(1.0, (last - first).total_seconds()) if (first and last) else 60.0
            rate_per_min = d["n"] * 60.0 / window_secs if window_secs > 0 else 0
            age_secs = (now - last).total_seconds() if last else None
            activity.append({
                "stream": d["stream"] or "(unknown)",
                "source_type": d["source_type"] or "?",
                "count": d["n"],
                "rate_per_min": rate_per_min,
                "last_seen": last,
                "age_secs": age_secs,
            })

        # Total rate estimate across the whole window
        if activity:
            window_first = min((a["last_seen"] for a in activity if a["last_seen"]), default=now)
            total_window_secs = max(1.0, (now - window_first).total_seconds())
            total_rate_per_sec = total / total_window_secs
        else:
            total_rate_per_sec = 0

        return render_template(
            "streams_activity.html",
            activity=activity,
            window=window,
            total=total,
            total_rate_per_sec=total_rate_per_sec,
            distinct_streams=len(activity),
        )

    @app.route("/streams")
    def streams_page():
        db = open_db()
        try:
            rows = LocalStreamService(db).list_stream_rows()
        finally:
            db.close()

        # Filters
        q = (request.args.get("q") or "").strip().lower()
        type_filter = (request.args.get("type") or "").strip().lower()
        status = (request.args.get("status") or "").strip().lower()  # 'enabled'|'disabled'|'error'

        type_counts: dict[str, int] = {}
        enabled_count = 0
        error_count = 0
        for r in rows:
            type_counts[r["stream_type"]] = type_counts.get(r["stream_type"], 0) + 1
            if r["enabled"]:
                enabled_count += 1
            if r["error"]:
                error_count += 1

        def keep(r) -> bool:
            if type_filter and r["stream_type"] != type_filter:
                return False
            if status == "enabled" and not r["enabled"]:
                return False
            if status == "disabled" and r["enabled"]:
                return False
            if status == "error" and not r["error"]:
                return False
            if q:
                hay = (r["name"] + " " + (r["detail"] or "")).lower()
                if q not in hay:
                    return False
            return True

        filtered = [r for r in rows if keep(r)]

        # Pagination
        try:
            page = max(1, int(request.args.get("page", "1")))
        except ValueError:
            page = 1
        per_page = 100
        total = len(filtered)
        pages = max(1, (total + per_page - 1) // per_page)
        page = min(page, pages)
        start = (page - 1) * per_page
        page_rows = filtered[start:start + per_page]

        return render_template(
            "streams.html",
            streams=page_rows,
            page=page,
            pages=pages,
            total=total,
            grand_total=len(rows),
            type_counts=sorted(type_counts.items(), key=lambda kv: -kv[1]),
            enabled_count=enabled_count,
            error_count=error_count,
            q=q,
            type_filter=type_filter,
            status=status,
        )

    @app.route("/streams/new")
    def new_stream_page():
        return redirect(url_for("new_email_stream_page"))

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
    db = LocalDatabase(app.config["DATABASE_URL"])
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
            db = LocalDatabase(app.config["DATABASE_URL"])
            monitor = LocalMonitor(db, bus=bus)
            asyncio.run(monitor.run())
        except Exception as exc:
            logger.exception("Embedded local monitor crashed: %s", exc)

    threading.Thread(target=_run_monitor, name="sentinel-local-monitor", daemon=True).start()
    return bus


def _row_to_sse_payload(row: Dict[str, Any]) -> tuple[str, str]:
    """Render an event row (LEFT JOINed with classification) into the
    (event_type, payload_json) pair the SSE client expects. If the row
    has classification fields populated we send item_classified;
    otherwise item_received."""
    payload: Dict[str, Any] = {
        "source_type": row.get("source_type"),
        "item_id": row.get("item_id"),
        "stream_name": row.get("stream_name"),
        "title": row.get("title"),
        "body": row.get("body"),
        "url": row.get("url"),
        "author": row.get("author"),
        "received_at": row.get("received_at").isoformat() if row.get("received_at") else None,
        "score": row.get("score"),
    }
    if row.get("priority"):
        payload.update({
            "priority": row.get("priority"),
            "summary": row.get("summary") or "",
            "reasoning": row.get("reasoning"),
        })
        event_type = "item_classified"
    else:
        event_type = "item_received"
    return event_type, json.dumps(payload, default=str)


def _sse_push_loop(database_url: str, cursor: int, bus: LiveEventBus):
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        q = bus.subscribe()
        heartbeat_countdown = 30
        try:
            db = LocalDatabase(database_url)
            try:
                while True:
                    rows = db.fetch_events_since(cursor, limit=200)
                    if rows:
                        for row in rows:
                            cursor = int(row["id"])
                            event_type, payload = _row_to_sse_payload(row)
                            yield _sse_frame(cursor, event_type, payload)
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


def _sse_poll_loop(database_url: str, cursor: int):
    def generate():
        nonlocal cursor
        yield "retry: 3000\n: connected\n\n"
        heartbeat_countdown = 30
        db = LocalDatabase(database_url)
        try:
            while True:
                rows = db.fetch_events_since(cursor, limit=200)
                if rows:
                    for row in rows:
                        cursor = int(row["id"])
                        event_type, payload = _row_to_sse_payload(row)
                        yield _sse_frame(cursor, event_type, payload)
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
