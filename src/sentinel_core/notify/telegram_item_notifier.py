"""Telegram formatter for Items.

Layout (lean — the first line is what shows on small previews like an Apple
Watch, so every character counts):

    <author or source-context>     (tappable link to the item if url is set)

    <title>

    <summary>

Source-type-specific author extraction:
  - email: bare address (no display name)
  - rss:   feed title
  - other: item.author
"""

from __future__ import annotations

from email.utils import parseaddr
from typing import Optional

from sentinel_core.classifier import ClassificationResult
from sentinel_core.logging_config import get_logger
from sentinel_core.notify.item_notifier import ItemNotifier
from sentinel_core.notify.telegram_notifier import TelegramNotifier
from sentinel_core.streams.base import Item

logger = get_logger(__name__)

_MD2_SPECIALS = r"_*[]()~`>#+-=|{}.!"


class TelegramItemNotifier(ItemNotifier):
    def __init__(self, telegram_notifier: TelegramNotifier):
        self.notifier = telegram_notifier

    def notify(self, item: Item, classification: ClassificationResult) -> Optional[str]:
        try:
            message = self._format(item, classification)
            return self.notifier.send(message)
        except Exception as e:
            logger.error(f"Failed to send Telegram notification: {e}")
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
    if item.source_type == "email":
        _, addr = parseaddr(item.author or "")
        return addr or item.author or "email"
    if item.source_type == "rss":
        feed = item.metadata.get("feed_title") if item.metadata else None
        return feed or item.author or "RSS"
    return item.author or item.source_type


def _md2_escape(text: str) -> str:
    out = []
    for ch in text:
        if ch in _MD2_SPECIALS:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def _url_escape(url: str) -> str:
    return url.replace("\\", "\\\\").replace(")", "\\)")
