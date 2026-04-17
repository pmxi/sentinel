"""Hosted Sentinel admin CLI."""

from __future__ import annotations

import secrets
import sys
from argparse import ArgumentParser, Namespace
from getpass import getpass
from typing import Optional

from sentinel_hosted.config import settings
from sentinel_hosted.database import HostedDatabase
from sentinel_hosted.web.app import run as run_web
from sentinel_hosted.worker import main as run_worker


def _open_db() -> HostedDatabase:
    return HostedDatabase(settings.DATABASE_PATH)


def _prompt(label: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def _prompt_secret(label: str) -> str:
    return getpass(f"{label}: ").strip()


def cmd_init(_args: Namespace) -> None:
    db = _open_db()
    settings.load(db)

    llm_key = _prompt_secret("OpenAI API key (required)")
    google_client_id = _prompt("Google OAuth client ID")
    google_client_secret = _prompt_secret("Google OAuth client secret")
    if not llm_key or not google_client_id or not google_client_secret:
        raise SystemExit("LLM API key and Google OAuth credentials are required.")

    db.set_app_setting("LLM_API_KEY", llm_key)
    db.set_app_setting("LLM_MODEL", _prompt("OpenAI model", default=settings.LLM_MODEL))
    db.set_app_setting("GOOGLE_CLIENT_ID", google_client_id)
    db.set_app_setting("GOOGLE_CLIENT_SECRET", google_client_secret)

    if not db.get_app_setting("SESSION_SECRET"):
        db.set_app_setting("SESSION_SECRET", secrets.token_hex(32))

    tg_token = _prompt_secret("Telegram bot token (or blank)")
    if tg_token:
        db.set_app_setting("TELEGRAM_BOT_TOKEN", tg_token)
        tg_user = _prompt("Telegram bot username (without @)")
        if tg_user:
            db.set_app_setting("TELEGRAM_BOT_USERNAME", tg_user.lstrip("@"))

    resend_key = _prompt_secret("Resend API key (or blank)")
    if resend_key:
        db.set_app_setting("RESEND_API_KEY", resend_key)
        from_addr = _prompt("From address")
        if from_addr:
            db.set_app_setting("EMAIL_FROM_ADDRESS", from_addr)
        db.set_app_setting("EMAIL_FROM_NAME", _prompt("From name", default="Sentinel"))

    db.set_app_setting(
        "MAX_LOOKBACK_HOURS",
        _prompt("Max lookback (hours)", default=str(settings.MAX_LOOKBACK_HOURS)),
    )

    print("\nHosted setup complete.")
    print("  - Start worker: sentinel-hosted worker")
    print("  - Start web:    sentinel-hosted web")


def cmd_web(args: Namespace) -> None:
    run_web(host=args.host, port=args.port, debug=args.debug)


def cmd_worker(_args: Namespace) -> None:
    run_worker()


def build_parser() -> ArgumentParser:
    parser = ArgumentParser(prog="sentinel-hosted")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Configure hosted runtime settings").set_defaults(func=cmd_init)
    sub.add_parser("worker", help="Start the hosted worker").set_defaults(func=cmd_worker)

    web = sub.add_parser("web", help="Start the hosted web UI")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8765)
    web.add_argument("--debug", action="store_true")
    web.set_defaults(func=cmd_web)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
