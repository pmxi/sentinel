"""Long-polling Telegram bot listener for the shared operator bot.

The bot has one job: handle `/start <token>` commands from users who are
mid-link. It looks the token up in `telegram_link_tokens`, writes the
user's chat_id into `user_settings`, and acks with a friendly message.

Runs as a background daemon thread kicked off by the monitor. Uses
long-polling (getUpdates) — no public webhook URL required. In prod
we can swap this for webhook-based intake once we have an HTTPS
endpoint, but the protocol and handlers are unchanged.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

import requests

from sentinel.config import settings
from sentinel.database import EmailDatabase
from sentinel.logging_config import get_logger

logger = get_logger(__name__)


TELEGRAM_API = "https://api.telegram.org"
POLL_TIMEOUT_S = 25  # long-poll; Telegram holds the connection up to this long
PURGE_INTERVAL_S = 300  # clean up expired link tokens every ~5 min


class TelegramBotListener:
    """Single-instance listener for the shared operator bot.

    The listener owns one sqlite connection in its own thread (sqlite
    connections aren't safely shared across threads). It holds an offset
    between polls so Telegram doesn't re-deliver the same update twice.
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._offset: Optional[int] = None
        self._stop = threading.Event()
        self._last_purge = 0.0

    def run_forever(self) -> None:
        """Blocking loop. Call from a dedicated thread."""
        if not settings.TELEGRAM_BOT_TOKEN:
            logger.warning(
                "TELEGRAM_BOT_TOKEN not configured; bot listener will not start"
            )
            return

        logger.info("Telegram bot listener starting (long-poll)")
        db = EmailDatabase(self.db_path)
        try:
            while not self._stop.is_set():
                try:
                    self._tick(db)
                except Exception as e:
                    logger.error(f"bot listener tick failed: {e}", exc_info=True)
                    time.sleep(5)
        finally:
            db.close()
            logger.info("Telegram bot listener stopped")

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------ internals

    def _tick(self, db: EmailDatabase) -> None:
        updates = self._get_updates()
        for update in updates:
            self._offset = int(update["update_id"]) + 1
            try:
                self._handle_update(db, update)
            except Exception as e:
                logger.error(f"failed to handle update {update.get('update_id')}: {e}", exc_info=True)

        now = time.monotonic()
        if now - self._last_purge > PURGE_INTERVAL_S:
            self._last_purge = now
            purged = db.purge_expired_telegram_link_tokens()
            if purged:
                logger.debug(f"purged {purged} expired telegram link token(s)")

    def _get_updates(self) -> list[Dict[str, Any]]:
        params: Dict[str, Any] = {"timeout": POLL_TIMEOUT_S}
        if self._offset is not None:
            params["offset"] = self._offset
        try:
            r = requests.get(
                f"{TELEGRAM_API}/bot{settings.TELEGRAM_BOT_TOKEN}/getUpdates",
                params=params,
                timeout=POLL_TIMEOUT_S + 10,
            )
            if r.status_code != 200:
                logger.warning(f"getUpdates returned {r.status_code}: {r.text[:200]}")
                time.sleep(2)
                return []
            body = r.json()
            if not body.get("ok"):
                logger.warning(f"getUpdates not-ok: {body}")
                return []
            return body.get("result", [])
        except requests.Timeout:
            return []
        except requests.RequestException as e:
            logger.warning(f"getUpdates error: {e}")
            time.sleep(5)
            return []

    def _handle_update(self, db: EmailDatabase, update: Dict[str, Any]) -> None:
        msg = update.get("message") or update.get("edited_message")
        if not msg:
            return
        text = (msg.get("text") or "").strip()
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if not text or chat_id is None:
            return

        if text.startswith("/start"):
            parts = text.split(maxsplit=1)
            arg = parts[1].strip() if len(parts) > 1 else ""
            self._handle_start(db, chat_id, arg)

    def _handle_start(self, db: EmailDatabase, chat_id: int, token: str) -> None:
        if not token:
            self._reply(
                chat_id,
                "👋 Sentinel here.\n\n"
                "To receive notifications, link this chat to your Sentinel account "
                "by clicking *Link Telegram* on the preferences page in the web UI.",
            )
            return

        user_id = db.consume_telegram_link_token(token)
        if user_id is None:
            self._reply(
                chat_id,
                "This link has expired or was already used. Open the web UI and "
                "click *Link Telegram* again.",
            )
            return

        db.set_user_setting(user_id, "TELEGRAM_CHAT_ID", str(chat_id))
        logger.info(f"linked user_id={user_id} to telegram chat_id={chat_id}")
        self._reply(
            chat_id,
            "✅ Linked. You'll receive a ping here when Sentinel finds an important email.",
        )

    def _reply(self, chat_id: int, text: str) -> None:
        try:
            requests.post(
                f"{TELEGRAM_API}/bot{settings.TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
                timeout=10,
            )
        except requests.RequestException as e:
            logger.warning(f"failed to reply to chat {chat_id}: {e}")


def start_in_thread(db_path: str) -> TelegramBotListener:
    """Spawn the listener on a daemon thread and return the controller."""
    listener = TelegramBotListener(db_path)
    t = threading.Thread(
        target=listener.run_forever, name="telegram-bot-listener", daemon=True
    )
    t.start()
    return listener
