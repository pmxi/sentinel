"""Sentinel command-line interface.

All configuration lives in the SQLite database. Commands:
  sentinel init           - set app-level secrets/preferences
  sentinel account list   - list configured accounts
  sentinel account add    - add a new mail account
  sentinel account remove - remove a mail account
  sentinel run            - start the monitor daemon
"""

from __future__ import annotations

import argparse
import json
import sys
from getpass import getpass
from pathlib import Path
from typing import Optional

from src.config import settings
from src.database import EmailDatabase
from src.email.mail_config import (
    AccountSettings,
    AuthConfig,
    AuthMethod,
    MailAccountConfig,
    MailProvider,
)


# ------------------------------------------------------------------ helpers

def _open_db() -> EmailDatabase:
    return EmailDatabase(settings.DATABASE_PATH)


def _prompt(label: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def _prompt_secret(label: str) -> str:
    return getpass(f"{label}: ").strip()


def _prompt_bool(label: str, default: bool = True) -> bool:
    default_str = "Y/n" if default else "y/N"
    value = input(f"{label} [{default_str}]: ").strip().lower()
    if not value:
        return default
    return value in ("y", "yes", "true", "1")


def _read_file_content(label: str) -> str:
    """Read the contents of a file the user points us at."""
    path_str = _prompt(f"Path to {label}")
    path = Path(path_str).expanduser()
    if not path.is_file():
        raise SystemExit(f"File not found: {path}")
    return path.read_text()


# ------------------------------------------------------------------ init

def cmd_init(_args: argparse.Namespace) -> None:
    db = _open_db()
    print("Sentinel first-time setup — press enter to accept defaults.\n")

    llm_key = _prompt_secret("Gemini API key (required)")
    if not llm_key:
        raise SystemExit("LLM_API_KEY is required.")
    db.set_app_setting("LLM_API_KEY", llm_key)

    llm_model = _prompt("Gemini model", default=settings.LLM_MODEL)
    db.set_app_setting("LLM_MODEL", llm_model)

    print("\nTelegram notifications (required):")
    tg_token = _prompt_secret("  Bot token")
    tg_chat = _prompt("  Chat ID")
    if not tg_token or not tg_chat:
        raise SystemExit("Telegram bot token and chat ID are required.")
    db.set_app_setting("TELEGRAM_BOT_TOKEN", tg_token)
    db.set_app_setting("TELEGRAM_CHAT_ID", tg_chat)

    print("\nMonitoring preferences:")
    db.set_app_setting(
        "POLL_INTERVAL_SECONDS",
        _prompt("  Poll interval (seconds)", default=str(settings.POLL_INTERVAL_SECONDS)),
    )
    db.set_app_setting(
        "MAX_LOOKBACK_HOURS",
        _prompt("  Max lookback (hours)", default=str(settings.MAX_LOOKBACK_HOURS)),
    )

    print("\nDone. Add an account with: sentinel account add")


# ------------------------------------------------------------------ account

def cmd_account_list(_args: argparse.Namespace) -> None:
    db = _open_db()
    accounts = db.list_accounts()
    if not accounts:
        print("No accounts configured. Run 'sentinel account add'.")
        return
    for name, raw in accounts.items():
        try:
            acc = MailAccountConfig.model_validate_json(raw)
            flag = "enabled" if acc.enabled else "disabled"
            print(f"  {name:20s} {acc.provider:10s} ({flag})")
        except Exception as e:
            print(f"  {name:20s} <invalid config: {e}>")


def cmd_account_remove(args: argparse.Namespace) -> None:
    db = _open_db()
    if not db.get_account(args.name):
        raise SystemExit(f"No account named '{args.name}'")
    db.delete_account(args.name)
    print(f"Removed account '{args.name}'")


def cmd_account_add(_args: argparse.Namespace) -> None:
    db = _open_db()
    name = _prompt("Account name (e.g. 'personal', 'work')")
    if not name:
        raise SystemExit("Account name is required.")
    if db.get_account(name):
        raise SystemExit(f"Account '{name}' already exists. Remove it first.")

    print("Providers: (1) gmail_api  (2) msgraph  (3) imap")
    choice = _prompt("Choose provider", default="1")
    provider = {
        "1": MailProvider.GMAIL_API,
        "gmail_api": MailProvider.GMAIL_API,
        "2": MailProvider.MSGRAPH,
        "msgraph": MailProvider.MSGRAPH,
        "3": MailProvider.IMAP,
        "imap": MailProvider.IMAP,
    }.get(choice.lower())
    if not provider:
        raise SystemExit(f"Unknown provider: {choice}")

    if provider == MailProvider.GMAIL_API:
        config = _prompt_gmail_account()
    elif provider == MailProvider.MSGRAPH:
        config = _prompt_msgraph_account()
    else:
        config = _prompt_imap_account()

    db.upsert_account(name, config.model_dump_json())
    print(f"\nAdded account '{name}' ({provider.value}).")
    if provider in (MailProvider.GMAIL_API, MailProvider.MSGRAPH):
        print("First run will open a browser to complete the OAuth flow.")


def _prompt_gmail_account() -> MailAccountConfig:
    print("\nPaste the path to the Google OAuth client JSON (from GCP Console).")
    client_config_json = _read_file_content("OAuth client JSON")
    # Validate it parses
    try:
        json.loads(client_config_json)
    except Exception as e:
        raise SystemExit(f"Invalid JSON: {e}")

    settings_obj = _prompt_account_settings()
    return MailAccountConfig(
        provider=MailProvider.GMAIL_API,
        auth=AuthConfig(
            method=AuthMethod.OAUTH2,
            client_config_json=client_config_json,
        ),
        settings=settings_obj,
    )


def _prompt_msgraph_account() -> MailAccountConfig:
    client_id = _prompt("Azure client ID")
    tenant_id = _prompt("Azure tenant ID (or 'common')", default="common")
    if not client_id:
        raise SystemExit("client_id is required.")

    settings_obj = _prompt_account_settings()
    return MailAccountConfig(
        provider=MailProvider.MSGRAPH,
        auth=AuthConfig(
            method=AuthMethod.OAUTH2,
            client_id=client_id,
            tenant_id=tenant_id,
        ),
        settings=settings_obj,
    )


def _prompt_imap_account() -> MailAccountConfig:
    server = _prompt("IMAP server (e.g. imap.example.com)")
    port = int(_prompt("IMAP port", default="993"))
    username = _prompt("Username")
    password = _prompt_secret("Password")
    if not server or not username or not password:
        raise SystemExit("server, username, and password are required.")

    settings_obj = _prompt_account_settings()
    return MailAccountConfig(
        provider=MailProvider.IMAP,
        server=server,
        port=port,
        auth=AuthConfig(
            method=AuthMethod.PASSWORD,
            username=username,
            password=password,
        ),
        settings=settings_obj,
    )


def _prompt_account_settings() -> AccountSettings:
    process_only_unread = _prompt_bool("Process only unread?", default=True)
    max_lookback = int(_prompt("Max lookback hours", default="24"))
    return AccountSettings(
        process_only_unread=process_only_unread,
        max_lookback_hours=max_lookback,
    )


# ------------------------------------------------------------------ run

def cmd_run(_args: argparse.Namespace) -> None:
    from src.main import main as run_main
    run_main()


# ------------------------------------------------------------------ entrypoint

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sentinel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="First-time app setup").set_defaults(func=cmd_init)
    sub.add_parser("run", help="Start the monitor daemon").set_defaults(func=cmd_run)

    account = sub.add_parser("account", help="Manage mail accounts")
    account_sub = account.add_subparsers(dest="account_cmd", required=True)
    account_sub.add_parser("list").set_defaults(func=cmd_account_list)
    account_sub.add_parser("add").set_defaults(func=cmd_account_add)
    rm = account_sub.add_parser("remove")
    rm.add_argument("name")
    rm.set_defaults(func=cmd_account_remove)

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
