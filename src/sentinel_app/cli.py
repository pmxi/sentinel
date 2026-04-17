"""Sentinel operator CLI.

Two deployment modes, picked at `sentinel init`:

  --local   single-user, no auth. CLI 'stream add/list/remove' target the
            implicit local user. Web UI requires no login.
  --hosted  multi-tenant, Google OAuth. End users manage their own streams
            via the web UI; CLI 'stream' subcommands take a --user-email
            to target a specific user.

  sentinel init --local | --hosted | (interactive)
  sentinel run                 start the supervisor daemon
  sentinel web                 start the web UI
  sentinel stream list         list streams
  sentinel stream add          add a stream (--type email|rss)
  sentinel stream remove NAME  remove a stream
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
from sentinel_core.streams.registry import ensure_loaded, get as get_spec
from sentinel_core.streams.rss.config import RSSStreamConfig


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
    Settings.load(db)
    mode = Settings.DEPLOYMENT_MODE
    if mode == "local":
        return _ensure_local_user(db)
    if not user_email:
        raise SystemExit(
            "Hosted mode requires --user-email <email> to identify which user "
            "this stream belongs to."
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
        "MAX_LOOKBACK_HOURS",
        _prompt("  Max lookback (hours)", default=str(settings.MAX_LOOKBACK_HOURS)),
    )

    if mode == "local":
        print("\nLocal setup complete.")
        print("  - Add a stream:      sentinel stream add --type email")
        print("  - Add an RSS feed:   sentinel stream add --type rss")
        print("  - Start the daemon:  sentinel run")
        print("  - Open the web UI:   sentinel web")
    else:
        print("\nHosted setup complete.")
        print("  - Start the web UI: sentinel web")
        print("  - Direct users to sign in with Google.")


# ------------------------------------------------------------------ stream

def cmd_stream_list(args: argparse.Namespace) -> None:
    ensure_loaded()
    db = _open_db()
    uid = _resolve_target_user(db, args.user_email)
    rows = db.list_streams(uid)
    if not rows:
        print("No streams configured. Run 'sentinel stream add --type email' or '--type rss'.")
        return
    for row in rows:
        name = row["name"]
        stream_type = row["stream_type"]
        try:
            spec = get_spec(stream_type)
            config = spec.config_cls.model_validate_json(row["config_json"])
            enabled = getattr(config, "enabled", True)
            flag = "enabled" if enabled else "disabled"
            detail = _describe_stream(stream_type, config)
            print(f"  {name:20s} {stream_type:8s} ({flag})  {detail}")
        except Exception as e:
            print(f"  {name:20s} {stream_type:8s} <invalid config: {e}>")


def _describe_stream(stream_type: str, config) -> str:
    if stream_type == "email":
        if config.provider == "imap" or config.provider == MailProvider.IMAP:
            return f"{config.auth.username}@{config.server}:{config.port}"
        return str(config.provider)
    if stream_type == "rss":
        return str(config.feed_url)
    return ""


def cmd_stream_remove(args: argparse.Namespace) -> None:
    db = _open_db()
    uid = _resolve_target_user(db, args.user_email)
    if not db.get_stream(uid, args.name):
        raise SystemExit(f"No stream named {args.name!r}")
    db.delete_stream(uid, args.name)
    print(f"Removed stream {args.name!r}")


def cmd_stream_add(args: argparse.Namespace) -> None:
    ensure_loaded()
    db = _open_db()
    uid = _resolve_target_user(db, args.user_email)

    stream_type = args.type
    if not stream_type:
        print("Stream types: (1) email  (2) rss")
        choice = _prompt("Choose stream type", default="1")
        stream_type = {"1": "email", "2": "rss", "email": "email", "rss": "rss"}.get(
            choice.lower(), "email"
        )

    name = _prompt("Stream name (e.g. 'personal', 'hn-frontpage')")
    if not name:
        raise SystemExit("Stream name is required.")
    if db.get_stream(uid, name):
        raise SystemExit(f"Stream {name!r} already exists. Remove it first.")

    if stream_type == "email":
        config_json = _prompt_email_stream()
    elif stream_type == "rss":
        config_json = _prompt_rss_stream()
    else:
        raise SystemExit(f"Unknown stream type: {stream_type!r}")

    db.upsert_stream(uid, name, stream_type, config_json)
    print(f"\nAdded stream {name!r} (type={stream_type}).")
    if stream_type == "email":
        print("If this is a Gmail/MSGraph account, the first daemon run will "
              "open a browser to complete OAuth.")


def _prompt_email_stream() -> str:
    print("Email providers: (1) imap  (2) gmail_api  (3) msgraph")
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
        config = _prompt_imap_config()
    elif provider == MailProvider.GMAIL_API:
        config = _prompt_gmail_config()
    else:
        config = _prompt_msgraph_config()

    return config.model_dump_json()


def _prompt_imap_config() -> MailAccountConfig:
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


def _prompt_gmail_config() -> MailAccountConfig:
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


def _prompt_msgraph_config() -> MailAccountConfig:
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


def _prompt_rss_stream() -> str:
    feed_url = _prompt("Feed URL (RSS or Atom)")
    if not feed_url:
        raise SystemExit("feed_url is required.")
    poll_seconds = int(_prompt("Poll interval (seconds)", default="300"))
    config = RSSStreamConfig(feed_url=feed_url, poll_seconds=poll_seconds)
    return config.model_dump_json()


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

    sub.add_parser("run", help="Start the supervisor daemon").set_defaults(func=cmd_run)

    web = sub.add_parser("web", help="Start the web UI")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8765)
    web.add_argument("--debug", action="store_true")
    web.set_defaults(func=cmd_web)

    stream = sub.add_parser("stream", help="Manage data streams (email, rss, ...)")
    stream_sub = stream.add_subparsers(dest="stream_cmd", required=True)

    for cmd_name, fn in [("list", cmd_stream_list)]:
        p = stream_sub.add_parser(cmd_name)
        p.add_argument("--user-email", help="Target user (hosted mode only)")
        p.set_defaults(func=fn)

    add = stream_sub.add_parser("add")
    add.add_argument("--type", choices=["email", "rss"], help="Stream type")
    add.add_argument("--user-email", help="Target user (hosted mode only)")
    add.set_defaults(func=cmd_stream_add)

    rm = stream_sub.add_parser("remove")
    rm.add_argument("name")
    rm.add_argument("--user-email", help="Target user (hosted mode only)")
    rm.set_defaults(func=cmd_stream_remove)

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
