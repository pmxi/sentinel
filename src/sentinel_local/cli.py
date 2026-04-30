"""Local Sentinel CLI."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from getpass import getpass
from pathlib import Path
from typing import Optional

from sentinel_lib.streams.bluesky.config import BlueskyStreamConfig
from sentinel_lib.streams.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel_lib.streams.rss.config import RSSStreamConfig
from sentinel_lib.streams.sitemap_news.config import SitemapNewsStreamConfig
from sentinel_local.config import settings
from sentinel_local.database import LocalDatabase
from sentinel_local.dev_firehose import FirehoseConfig, run_firehose
from sentinel_local.monitor import LocalMonitor
from sentinel_local.services.settings import LocalSetupService
from sentinel_local.services.streams import LocalStreamService
from sentinel_local.web.app import run as run_web


def _open_db() -> LocalDatabase:
    return LocalDatabase(settings.DATABASE_PATH)


def _prompt(label: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or (default or "")


def _prompt_secret(label: str) -> str:
    return getpass(f"{label}: ").strip()


def _read_file_content(label: str) -> str:
    path_str = _prompt(f"Path to {label}")
    path = Path(path_str).expanduser()
    if not path.is_file():
        raise SystemExit(f"File not found: {path}")
    return path.read_text()


def cmd_init(_args: argparse.Namespace) -> None:
    db = _open_db()
    settings.load(db)
    LocalSetupService(db).initialize(
        llm_api_key=_prompt_secret("OpenAI API key (required)"),
        llm_model=_prompt("OpenAI model", default=settings.LLM_MODEL),
        telegram_bot_token=_prompt_secret("Telegram bot token (or blank to skip)"),
        telegram_bot_username=_prompt("Telegram bot username (or blank)"),
        resend_api_key=_prompt_secret("Resend API key (or blank)"),
        email_from_address=_prompt("From address (or blank)"),
        email_from_name=_prompt("From name", default="Sentinel"),
        max_lookback_hours=_prompt(
            "Max lookback (hours)",
            default=str(settings.MAX_LOOKBACK_HOURS),
        ),
    )
    print("\nLocal setup complete.")
    print("  - Add a stream:    sentinel stream add --type email")
    print("  - Add an RSS feed: sentinel stream add --type rss")
    print("  - Start monitor:   sentinel run")
    print("  - Open web UI:     sentinel web")
    print("  - Drive test load: sentinel dev firehose --rate 20 --count 200")


def cmd_stream_list(_args: argparse.Namespace) -> None:
    db = _open_db()
    rows = LocalStreamService(db).list_stream_rows()
    if not rows:
        print("No streams configured. Run 'sentinel stream add --type email' or '--type rss'.")
        return
    for row in rows:
        status = "enabled" if row["enabled"] else "disabled"
        detail = row["error"] or row["detail"]
        print(f"  {row['name']:20s} {row['stream_type']:8s} ({status})  {detail}")


def cmd_stream_remove(args: argparse.Namespace) -> None:
    db = _open_db()
    LocalStreamService(db).delete_stream(args.name)
    print(f"Removed stream {args.name!r}")


def cmd_stream_add(args: argparse.Namespace) -> None:
    db = _open_db()
    service = LocalStreamService(db)
    stream_type = args.type
    if not stream_type:
        print("Stream types: (1) email  (2) rss  (3) bluesky  (4) sitemap_news")
        choice = _prompt("Choose stream type", default="1")
        stream_type = {
            "1": "email",
            "2": "rss",
            "3": "bluesky",
            "4": "sitemap_news",
            "email": "email",
            "rss": "rss",
            "bluesky": "bluesky",
            "sitemap_news": "sitemap_news",
        }.get(choice.lower(), "email")

    name = _prompt("Stream name (e.g. 'personal', 'hn-frontpage')")
    if not name:
        raise SystemExit("Stream name is required.")

    if stream_type == "email":
        config_json = _prompt_email_stream()
    elif stream_type == "rss":
        config_json = _prompt_rss_stream()
    elif stream_type == "bluesky":
        config_json = BlueskyStreamConfig().model_dump_json()
    elif stream_type == "sitemap_news":
        sitemap_url = _prompt("Sitemap URL (e.g. https://www.bloomberg.com/sitemaps/news/latest.xml)")
        publication = _prompt("Publication display name", default=name)
        config_json = SitemapNewsStreamConfig(
            sitemap_url=sitemap_url,
            publication_name=publication,
        ).model_dump_json()
    else:
        raise SystemExit(f"Unknown stream type: {stream_type!r}")

    service.add_stream(name, stream_type, config_json)
    print(f"\nAdded stream {name!r} (type={stream_type}).")


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
    except Exception as exc:
        raise SystemExit(f"Invalid JSON: {exc}")
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
    process_only_unread = _prompt("Process only unread? [Y/n]", default="Y").lower() not in {"n", "no", "false", "0"}
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


def cmd_run(_args: argparse.Namespace) -> None:
    db = _open_db()
    settings.load(db)
    settings.validate()
    asyncio.run(LocalMonitor(db).run())


def cmd_web(args: argparse.Namespace) -> None:
    run_web(host=args.host, port=args.port, debug=args.debug)


def cmd_dev_firehose(args: argparse.Namespace) -> None:
    count = None if args.count == 0 else args.count
    config = FirehoseConfig(
        rate=args.rate,
        count=count,
        source_type=args.source_type,
        stream_name=args.stream_name,
        classify_delay_ms=args.classify_delay_ms,
        important_every=args.important_every,
    )
    target = "until interrupted" if count is None else f"for {count} items"
    print(
        f"Emitting synthetic {config.source_type} traffic into {settings.DATABASE_PATH} "
        f"at {config.rate:.2f} items/sec {target}. Press Ctrl-C to stop."
    )
    try:
        emitted = run_firehose(settings.DATABASE_PATH, config)
    except KeyboardInterrupt:
        print("\nStopped.")
        return
    print(f"Emitted {emitted} synthetic item(s).")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sentinel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Configure the local runtime").set_defaults(func=cmd_init)
    sub.add_parser("run", help="Start the local supervisor").set_defaults(func=cmd_run)

    web = sub.add_parser("web", help="Start the local web UI")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8765)
    web.add_argument("--debug", action="store_true")
    web.set_defaults(func=cmd_web)

    stream = sub.add_parser("stream", help="Manage local data streams")
    stream_sub = stream.add_subparsers(dest="stream_cmd", required=True)

    stream_sub.add_parser("list").set_defaults(func=cmd_stream_list)

    add = stream_sub.add_parser("add")
    add.add_argument("--type", choices=["email", "rss", "bluesky", "sitemap_news"], help="Stream type")
    add.set_defaults(func=cmd_stream_add)

    rm = stream_sub.add_parser("remove")
    rm.add_argument("name")
    rm.set_defaults(func=cmd_stream_remove)

    dev = sub.add_parser("dev", help="Developer helpers for local testing")
    dev_sub = dev.add_subparsers(dest="dev_cmd", required=True)

    firehose = dev_sub.add_parser(
        "firehose",
        help="Emit synthetic dashboard traffic into the local sqlite db",
    )
    firehose.add_argument(
        "--rate",
        type=float,
        default=20.0,
        help="Synthetic items per second (default: 20)",
    )
    firehose.add_argument(
        "--count",
        type=int,
        default=200,
        help="How many items to emit; use 0 to run until interrupted (default: 200)",
    )
    firehose.add_argument(
        "--source-type",
        default="rss",
        help="Source label shown in the dashboard (default: rss)",
    )
    firehose.add_argument(
        "--stream-name",
        default="dev-firehose",
        help="Stream label shown in the dashboard (default: dev-firehose)",
    )
    firehose.add_argument(
        "--classify-delay-ms",
        type=int,
        default=120,
        help="Delay between received and classified events (default: 120)",
    )
    firehose.add_argument(
        "--important-every",
        type=int,
        default=5,
        help="Mark every Nth item as important; 0 disables important items (default: 5)",
    )
    firehose.set_defaults(func=cmd_dev_firehose)

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
