"""Sentinel operator CLI.

Two deployment modes, picked at `sentinel init`:

  --local   single-user, no auth. CLI 'account add/list/remove' work and
            target the implicit local user. Web UI requires no login.
  --hosted  multi-tenant, Google OAuth. End users manage their own
            accounts via the web UI; CLI 'account' subcommands take a
            --user-email to target a specific user.

  sentinel init --local | --hosted | (interactive)
  sentinel run                start the monitor daemon
  sentinel web                start the web UI
  sentinel account list       list accounts (local: singleton; hosted: --user-email)
  sentinel account add        add a mail account
  sentinel account remove     remove a mail account
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from getpass import getpass
from pathlib import Path
from typing import Optional

from sentinel_core.config import Settings, settings
from sentinel_core.database import EmailDatabase
from sentinel_core.streams.email.mail_config import (
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
    path_str = _prompt(f"Path to {label}")
    path = Path(path_str).expanduser()
    if not path.is_file():
        raise SystemExit(f"File not found: {path}")
    return path.read_text()


def _ensure_local_user(db: EmailDatabase) -> int:
    """Return the singleton local user id, creating the row + setting if missing."""
    stored = db.get_app_setting("LOCAL_USER_ID")
    if stored:
        uid = int(stored)
        if db.get_user(uid):
            return uid
    uid = db.upsert_user(
        google_sub="local-singleton",
        email="local@sentinel",
        name="Local user",
    )
    db.set_app_setting("LOCAL_USER_ID", str(uid))
    return uid


def _resolve_target_user(db: EmailDatabase, user_email: Optional[str]) -> int:
    """Pick the user_id for an account command based on deployment mode."""
    Settings.load(db)
    mode = Settings.DEPLOYMENT_MODE
    if mode == "local":
        return _ensure_local_user(db)
    if not user_email:
        raise SystemExit(
            "Hosted mode requires --user-email <email> to identify which user "
            "this account belongs to."
        )
    for u in db.list_users():
        if u["email"].lower() == user_email.lower():
            return int(u["id"])
    raise SystemExit(f"No user found with email {user_email!r}")


# ------------------------------------------------------------------ init

def cmd_init(args: argparse.Namespace) -> None:
    db = _open_db()
    Settings.load(db)

    mode = args.mode
    if not mode:
        print("Pick a deployment mode:")
        print("  1) local  — single user, no auth (self-hosted)")
        print("  2) hosted — multi-tenant, Google OAuth")
        choice = _prompt("Choose", default="1")
        mode = "hosted" if choice.strip() in ("2", "hosted") else "local"
    db.set_app_setting("DEPLOYMENT_MODE", mode)
    print(f"\nDeployment mode: {mode}\n")

    if mode == "local":
        _ensure_local_user(db)

    llm_key = _prompt_secret("OpenAI API key (required)")
    if not llm_key:
        raise SystemExit("LLM_API_KEY is required.")
    db.set_app_setting("LLM_API_KEY", llm_key)

    llm_model = _prompt("OpenAI model", default=settings.LLM_MODEL)
    db.set_app_setting("LLM_MODEL", llm_model)

    if mode == "hosted":
        print("\nGoogle OAuth (identity — 'openid email profile' scopes, no verification needed):")
        google_client_id = _prompt("  Client ID")
        google_client_secret = _prompt_secret("  Client secret")
        if not google_client_id or not google_client_secret:
            raise SystemExit("Google OAuth client id and secret are required for hosted mode.")
        db.set_app_setting("GOOGLE_CLIENT_ID", google_client_id)
        db.set_app_setting("GOOGLE_CLIENT_SECRET", google_client_secret)

    if not db.get_app_setting("SESSION_SECRET"):
        db.set_app_setting("SESSION_SECRET", secrets.token_hex(32))
        print("  Generated SESSION_SECRET (persisted; keep across restarts)")

    print("\nTelegram shared bot (optional):")
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

    if mode == "local":
        print("\nLocal setup complete.")
        print("  - Add a mail account: sentinel account add")
        print("  - Start the daemon:   sentinel run")
        print("  - Open the web UI:    sentinel web")
    else:
        print("\nHosted setup complete.")
        print("  - Start the web UI: sentinel web")
        print("  - Direct users to sign in with Google.")


# ------------------------------------------------------------------ account

def cmd_account_list(args: argparse.Namespace) -> None:
    db = _open_db()
    uid = _resolve_target_user(db, args.user_email)
    accounts = db.list_accounts(uid)
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
    uid = _resolve_target_user(db, args.user_email)
    if not db.get_account(uid, args.name):
        raise SystemExit(f"No account named {args.name!r}")
    db.delete_account(uid, args.name)
    print(f"Removed account {args.name!r}")


def cmd_account_add(args: argparse.Namespace) -> None:
    db = _open_db()
    uid = _resolve_target_user(db, args.user_email)

    name = _prompt("Account name (e.g. 'personal', 'work')")
    if not name:
        raise SystemExit("Account name is required.")
    if db.get_account(uid, name):
        raise SystemExit(f"Account {name!r} already exists. Remove it first.")

    print("Providers: (1) imap  (2) gmail_api  (3) msgraph")
    choice = _prompt("Choose provider", default="1")
    provider = {
        "1": MailProvider.IMAP,
        "imap": MailProvider.IMAP,
        "2": MailProvider.GMAIL_API,
        "gmail_api": MailProvider.GMAIL_API,
        "3": MailProvider.MSGRAPH,
        "msgraph": MailProvider.MSGRAPH,
    }.get(choice.lower())
    if not provider:
        raise SystemExit(f"Unknown provider: {choice}")

    if provider == MailProvider.IMAP:
        config = _prompt_imap_account()
    elif provider == MailProvider.GMAIL_API:
        config = _prompt_gmail_account()
    else:
        config = _prompt_msgraph_account()

    db.upsert_account(uid, name, config.model_dump_json())
    print(f"\nAdded account {name!r} ({provider.value}).")
    if provider in (MailProvider.GMAIL_API, MailProvider.MSGRAPH):
        print("First daemon run will open a browser to complete OAuth.")


def _prompt_imap_account() -> MailAccountConfig:
    server = _prompt("IMAP server (e.g. imap.gmail.com)")
    port = int(_prompt("IMAP port", default="993"))
    username = _prompt("Username (email address)")
    password = _prompt_secret("App password")
    if not server or not username or not password:
        raise SystemExit("server, username, and password are required.")
    return MailAccountConfig(
        provider=MailProvider.IMAP,
        server=server,
        port=port,
        auth=AuthConfig(method=AuthMethod.PASSWORD, username=username, password=password),
        settings=_prompt_account_settings(),
    )


def _prompt_gmail_account() -> MailAccountConfig:
    print("\nPaste the path to the Google OAuth client JSON (from GCP Console).")
    client_config_json = _read_file_content("OAuth client JSON")
    try:
        json.loads(client_config_json)
    except Exception as e:
        raise SystemExit(f"Invalid JSON: {e}")
    return MailAccountConfig(
        provider=MailProvider.GMAIL_API,
        auth=AuthConfig(method=AuthMethod.OAUTH2, client_config_json=client_config_json),
        settings=_prompt_account_settings(),
    )


def _prompt_msgraph_account() -> MailAccountConfig:
    client_id = _prompt("Azure client ID")
    tenant_id = _prompt("Azure tenant ID (or 'common')", default="common")
    if not client_id:
        raise SystemExit("client_id is required.")
    return MailAccountConfig(
        provider=MailProvider.MSGRAPH,
        auth=AuthConfig(method=AuthMethod.OAUTH2, client_id=client_id, tenant_id=tenant_id),
        settings=_prompt_account_settings(),
    )


def _prompt_account_settings() -> AccountSettings:
    process_only_unread = _prompt_bool("Process only unread?", default=True)
    max_lookback = int(_prompt("Max lookback hours", default="24"))
    return AccountSettings(
        process_only_unread=process_only_unread,
        max_lookback_hours=max_lookback,
    )


# ------------------------------------------------------------------ run / web

def cmd_run(_args: argparse.Namespace) -> None:
    from sentinel_app.main import main as run_main
    run_main()


def cmd_web(args: argparse.Namespace) -> None:
    from sentinel_app.web.app import run as run_web
    run_web(host=args.host, port=args.port, debug=args.debug)


# ------------------------------------------------------------------ entrypoint

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sentinel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    init = sub.add_parser("init", help="Configure deployment mode + app-level secrets")
    mode_group = init.add_mutually_exclusive_group()
    mode_group.add_argument("--local", dest="mode", action="store_const", const="local",
                            help="Single-user self-hosted mode (no auth)")
    mode_group.add_argument("--hosted", dest="mode", action="store_const", const="hosted",
                            help="Multi-tenant hosted mode (Google OAuth)")
    init.set_defaults(func=cmd_init, mode=None)

    sub.add_parser("run", help="Start the monitor daemon").set_defaults(func=cmd_run)

    web = sub.add_parser("web", help="Start the web UI")
    web.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    web.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    web.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    web.set_defaults(func=cmd_web)

    account = sub.add_parser("account", help="Manage mail accounts")
    account_sub = account.add_subparsers(dest="account_cmd", required=True)
    for cmd_name, fn in [("list", cmd_account_list), ("add", cmd_account_add)]:
        p = account_sub.add_parser(cmd_name)
        p.add_argument("--user-email", help="Target user (hosted mode only; defaults to local singleton)")
        p.set_defaults(func=fn)
    rm = account_sub.add_parser("remove")
    rm.add_argument("name")
    rm.add_argument("--user-email", help="Target user (hosted mode only; defaults to local singleton)")
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
