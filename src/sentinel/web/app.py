"""Flask web app for configuring and monitoring Sentinel at runtime.

The app reads/writes the same SQLite database the daemon uses. Changes to
app_settings and account configs take effect the next time the daemon
reloads them — which today only happens on daemon restart, since
Settings.load(db) and MailboxesConfig.from_db(db) are called once at
startup. A running daemon will pick up toggled accounts and updated
notes only after a restart.

Bind is 127.0.0.1 by default. There's no auth layer; don't expose to
the public internet.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Dict, List

from flask import Flask, redirect, render_template, request, url_for

from sentinel.config import Settings, settings
from sentinel.database import EmailDatabase
from sentinel.email.mail_config import MailAccountConfig


# Settings exposed in the UI. Order here is the order they appear on the form.
# (key, label, input type — "text" | "password" | "number")
EDITABLE_SETTINGS: List[tuple[str, str, str]] = [
    ("LLM_API_KEY", "OpenAI API key", "password"),
    ("LLM_MODEL", "OpenAI model", "text"),
    ("TELEGRAM_BOT_TOKEN", "Telegram bot token", "password"),
    ("TELEGRAM_CHAT_ID", "Telegram chat ID", "text"),
    ("POLL_INTERVAL_SECONDS", "Poll interval (seconds)", "number"),
    ("MAX_LOOKBACK_HOURS", "Max lookback (hours)", "number"),
    ("LOG_LEVEL", "Log level", "text"),
]

SECRET_KEYS = {"LLM_API_KEY", "TELEGRAM_BOT_TOKEN"}


def create_app(db_path: str | None = None) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["DB_PATH"] = db_path or settings.DATABASE_PATH

    def open_db() -> EmailDatabase:
        return EmailDatabase(app.config["DB_PATH"])

    @app.route("/")
    def dashboard():
        db = open_db()
        try:
            processed_count = db.get_processed_count()
            last_check = db.get_last_check_time()
            monitoring_start = db.get_monitoring_start_time()
            recent = _fetch_recent_processed(db, limit=25)
            accounts_count = len(db.list_accounts())
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

    @app.route("/settings", methods=["GET", "POST"])
    def settings_page():
        db = open_db()
        try:
            if request.method == "POST":
                for key, _label, _type in EDITABLE_SETTINGS:
                    raw = request.form.get(key, "").strip()
                    # For secrets, don't wipe the stored value when the field was left blank.
                    if not raw and key in SECRET_KEYS:
                        continue
                    if raw:
                        db.set_app_setting(key, raw)
                return redirect(url_for("settings_page", saved=1))

            current = db.get_all_app_settings()
            rows = []
            for key, label, kind in EDITABLE_SETTINGS:
                value = current.get(key, "")
                display = _mask(value) if key in SECRET_KEYS and value else value
                rows.append({
                    "key": key,
                    "label": label,
                    "type": kind,
                    "value": "" if key in SECRET_KEYS else value,
                    "display": display,
                    "is_secret": key in SECRET_KEYS,
                    "is_set": bool(value),
                })
            return render_template(
                "settings.html",
                rows=rows,
                saved=request.args.get("saved") == "1",
            )
        finally:
            db.close()

    @app.route("/prompt", methods=["GET", "POST"])
    def prompt_page():
        db = open_db()
        try:
            if request.method == "POST":
                notes = request.form.get("CLASSIFICATION_NOTES", "")
                db.set_app_setting("CLASSIFICATION_NOTES", notes)
                return redirect(url_for("prompt_page", saved=1))

            notes = db.get_app_setting("CLASSIFICATION_NOTES") or ""
            return render_template(
                "prompt.html",
                notes=notes,
                base_prompt=_base_prompt_preview(),
                saved=request.args.get("saved") == "1",
            )
        finally:
            db.close()

    @app.route("/accounts")
    def accounts_page():
        db = open_db()
        try:
            rows = []
            for name, raw in db.list_accounts().items():
                try:
                    acc = MailAccountConfig.model_validate_json(raw)
                    rows.append({
                        "name": name,
                        "provider": acc.provider,
                        "enabled": acc.enabled,
                    })
                except Exception as e:  # pragma: no cover - defensive
                    rows.append({"name": name, "provider": "invalid", "enabled": False, "error": str(e)})
            return render_template("accounts.html", accounts=rows)
        finally:
            db.close()

    @app.route("/accounts/<name>/toggle", methods=["POST"])
    def toggle_account(name: str):
        db = open_db()
        try:
            raw = db.get_account(name)
            if not raw:
                return ("not found", 404)
            data = json.loads(raw)
            data["enabled"] = not data.get("enabled", True)
            db.upsert_account(name, json.dumps(data))
            return redirect(url_for("accounts_page"))
        finally:
            db.close()

    return app


def _mask(value: str) -> str:
    if len(value) <= 6:
        return "•" * len(value)
    return "•" * (len(value) - 4) + value[-4:]


def _daemon_health(last_check: datetime | None) -> Dict[str, Any]:
    """Heuristic: if the daemon wrote a last_check_time within 3x the poll
    interval, call it healthy. Otherwise stale or never run."""
    if last_check is None:
        return {"status": "never run", "ok": False}
    age_s = (datetime.now() - last_check).total_seconds()
    threshold = max(3 * Settings.POLL_INTERVAL_SECONDS, 60)
    if age_s < threshold:
        return {"status": f"running (last check {int(age_s)}s ago)", "ok": True}
    return {"status": f"stale (last check {int(age_s)}s ago)", "ok": False}


def _fetch_recent_processed(db: EmailDatabase, limit: int = 25) -> List[Dict[str, Any]]:
    cursor = db.conn.execute(
        "SELECT email_id, provider, subject, sender, processed_at "
        "FROM processed_emails ORDER BY processed_at DESC LIMIT ?",
        (limit,),
    )
    return [dict(row) for row in cursor.fetchall()]


def _base_prompt_preview() -> str:
    """Render the base (pre-notes) classifier prompt for display only."""
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
    """Start the Flask dev server. Bound to localhost by default; the app has
    no auth layer, so don't bind to 0.0.0.0 without adding one."""
    app = create_app()
    app.run(host=host, port=port, debug=debug)
