"""Sentinel operator CLI.

With the multi-tenant refactor, end-user account management (adding mail
accounts, setting Telegram creds, editing classification notes) moves to
the web UI. The CLI is now operator-only, for:

  sentinel init    - set app-level secrets (OpenAI, Resend, Google OAuth,
                     session secret, poll interval)
  sentinel run     - start the monitor daemon (iterates all users)
  sentinel web     - start the web UI (signup/login + per-user settings)

`sentinel account ...` is no longer available — users manage their own
accounts through the web UI after signing in with Google.
"""

from __future__ import annotations

import argparse
import secrets
import sys
from getpass import getpass
from typing import Optional

from sentinel.config import settings
from sentinel.database import EmailDatabase


def _open_db() -> EmailDatabase:
    return EmailDatabase(settings.DATABASE_PATH)


def _prompt(label: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def _prompt_secret(label: str) -> str:
    return getpass(f"{label}: ").strip()


# ------------------------------------------------------------------ init

def cmd_init(_args: argparse.Namespace) -> None:
    db = _open_db()
    print("Sentinel operator setup — press enter to accept defaults.\n")

    llm_key = _prompt_secret("OpenAI API key (required)")
    if not llm_key:
        raise SystemExit("LLM_API_KEY is required.")
    db.set_app_setting("LLM_API_KEY", llm_key)

    llm_model = _prompt("OpenAI model", default=settings.LLM_MODEL)
    db.set_app_setting("LLM_MODEL", llm_model)

    print("\nGoogle OAuth (identity — 'openid email profile' scopes, no verification needed):")
    google_client_id = _prompt("  Client ID")
    google_client_secret = _prompt_secret("  Client secret")
    if not google_client_id or not google_client_secret:
        raise SystemExit("Google OAuth client id and secret are required.")
    db.set_app_setting("GOOGLE_CLIENT_ID", google_client_id)
    db.set_app_setting("GOOGLE_CLIENT_SECRET", google_client_secret)

    if not db.get_app_setting("SESSION_SECRET"):
        db.set_app_setting("SESSION_SECRET", secrets.token_hex(32))
        print("  Generated SESSION_SECRET (persisted; keep across restarts)")

    print("\nTelegram shared bot (optional — users opt-in via /preferences → Link Telegram):")
    tg_token = _prompt_secret("  Bot token (or blank to skip)")
    if tg_token:
        db.set_app_setting("TELEGRAM_BOT_TOKEN", tg_token)
        tg_user = _prompt("  Bot username (without @; used in t.me/<user> deep link)")
        if tg_user:
            db.set_app_setting("TELEGRAM_BOT_USERNAME", tg_user.lstrip("@"))

    print("\nResend (transactional email — optional, skip with blank):")
    resend_key = _prompt_secret("  Resend API key (or blank)")
    if resend_key:
        db.set_app_setting("RESEND_API_KEY", resend_key)
        from_addr = _prompt("  From address (e.g. noreply@yourdomain.com)")
        if from_addr:
            db.set_app_setting("EMAIL_FROM_ADDRESS", from_addr)
        from_name = _prompt("  From name", default="Sentinel")
        db.set_app_setting("EMAIL_FROM_NAME", from_name)

    print("\nMonitoring preferences:")
    db.set_app_setting(
        "POLL_INTERVAL_SECONDS",
        _prompt("  Poll interval (seconds)", default=str(settings.POLL_INTERVAL_SECONDS)),
    )
    db.set_app_setting(
        "MAX_LOOKBACK_HOURS",
        _prompt("  Max lookback (hours)", default=str(settings.MAX_LOOKBACK_HOURS)),
    )

    print("\nOperator setup complete. Start the web UI with 'sentinel web'")
    print("and direct users to sign in with Google.")


# ------------------------------------------------------------------ run / web

def cmd_run(_args: argparse.Namespace) -> None:
    from sentinel.main import main as run_main
    run_main()


def cmd_web(args: argparse.Namespace) -> None:
    from sentinel.web.app import run as run_web
    run_web(host=args.host, port=args.port, debug=args.debug)


# ------------------------------------------------------------------ entrypoint

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sentinel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Configure app-level secrets").set_defaults(func=cmd_init)
    sub.add_parser("run", help="Start the monitor daemon").set_defaults(func=cmd_run)

    web = sub.add_parser("web", help="Start the web UI")
    web.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    web.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    web.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
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
