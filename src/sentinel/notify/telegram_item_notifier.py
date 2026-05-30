"""Telegram formatter for Items.

Layout (lean — the first line is what shows on small previews like an Apple
Watch, so every character counts):

    <sender address>     (tappable link to the item if url is set)

    <title>

    <summary>

The first line is the sender's bare email address (display name stripped).
"""

from __future__ import annotations

from email.utils import parseaddr
from typing import Callable, Optional

import requests

from sentinel.logging_config import get_logger
from sentinel.classifier import ClassificationResult
from sentinel.item import Item

logger = get_logger(__name__)

_MD2_SPECIALS = r"_*[]()~`>#+-=|{}.!"


class TelegramItemNotifier:
    """Formats an Item for Telegram and sends it to the owner's chat.

    The destination chat_id is resolved lazily via `chat_id_provider` at send
    time, not captured up front — so a user who links Telegram after the worker
    is already polling still gets their next important item. Returns None
    without sending if the user hasn't linked a chat yet.
    """

    def __init__(self, bot_token: str, chat_id_provider: Callable[[], Optional[str]]):
        self._bot_token = bot_token
        self._chat_id_provider = chat_id_provider

    def notify(self, item: Item, classification: ClassificationResult) -> Optional[str]:
        chat_id = self._chat_id_provider()
        if not chat_id:
            return None
        try:
            message = self._format(item, classification)
            return self._send(str(chat_id), message)
        except Exception as e:
            logger.error(f"Failed to send Telegram notification: {e}")
            return None

    def _send(self, chat_id: str, text: str) -> Optional[str]:
        """POST the message to Telegram (MarkdownV2). Returns the provider
        message id on success, else None."""
        resp = requests.post(
            f"https://api.telegram.org/bot{self._bot_token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "MarkdownV2",
                "disable_notification": False,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            return str(resp.json().get("result", {}).get("message_id"))
        logger.error("Telegram sendMessage failed: %s - %s", resp.status_code, resp.text)
        return None

    def _format(self, item: Item, classification: ClassificationResult) -> str:
        summary = classification.summary or ""
        if len(summary) > 500:
            summary = summary[:497] + "..."

        header = _attribution(item)

        first_line = (
            f"[{_md2_escape(header)}]({_url_escape(item.url)})"
            if item.url
            else _md2_escape(header)
        )

        return (
            f"{first_line}\n\n"
            f"{_md2_escape(item.title)}\n\n"
            f"{_md2_escape(summary)}"
        )


def _attribution(item: Item) -> str:
    """The text that goes on the first line of the notification."""
    _, addr = parseaddr(item.author or "")
    return addr or item.author or "email"


def _md2_escape(text: str) -> str:
    out = []
    for ch in text:
        if ch in _MD2_SPECIALS:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def _url_escape(url: str) -> str:
    return url.replace("\\", "\\\\").replace(")", "\\)")
