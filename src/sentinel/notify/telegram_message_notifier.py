"""Telegram formatter for Messages.

Layout (lean — the first line is what shows on small previews like an Apple
Watch, so every character counts):

    <sender address>     (tappable link to the message if url is set)

    <summary>

The first line is the sender's bare email address (display name stripped).
"""

from __future__ import annotations

from dataclasses import dataclass
from email.utils import parseaddr
from enum import Enum
from typing import Callable, Optional

import requests

from sentinel.logging_config import get_logger
from sentinel.classifier import ClassificationResult
from sentinel.message import Message

logger = get_logger(__name__)

_MD2_SPECIALS = r"_*[]()~`>#+-=|{}.!"


class NotifyStatus(str, Enum):
    SENT = "sent"
    SKIPPED = "skipped"
    FAILED = "failed"


@dataclass(frozen=True)
class NotifyResult:
    """Why a notify attempt did (or didn't) deliver.

    detail carries the provider message id when sent, otherwise the reason —
    so the caller can log a cause instead of silently dropping a None.

    retryable marks a FAILED result the caller may sensibly re-attempt (a
    network blip or a Telegram 5xx), as opposed to a permanent rejection.
    """

    status: NotifyStatus
    detail: str = ""
    retryable: bool = False


class TelegramMessageNotifier:
    """Formats a Message for Telegram and sends it to the owner's chat.

    The destination chat_id is resolved lazily via `chat_id_provider` at send
    time, not captured up front — so a user who links Telegram after the worker
    is already polling still gets their next important message. Returns a
    NotifyResult describing the outcome (sent / skipped / failed) so the caller
    can log why nothing was delivered rather than dropping a silent None.
    """

    def __init__(self, bot_token: str, chat_id_provider: Callable[[], Optional[str]]):
        self._bot_token = bot_token
        self._chat_id_provider = chat_id_provider

    def notify(self, message: Message, classification: ClassificationResult) -> NotifyResult:
        chat_id = self._chat_id_provider()
        if not chat_id:
            return NotifyResult(NotifyStatus.SKIPPED, "telegram_unlinked")
        text = self._format(message, classification)
        try:
            message_id = self._send(str(chat_id), text)
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as e:
            # A blip or a Telegram 5xx — worth another attempt.
            logger.warning(f"Transient Telegram notify error: {e}")
            return NotifyResult(NotifyStatus.FAILED, str(e), retryable=True)
        except Exception as e:
            logger.error(f"Failed to send Telegram notification: {e}")
            return NotifyResult(NotifyStatus.FAILED, str(e))
        if message_id is None:
            return NotifyResult(NotifyStatus.FAILED, "send_rejected")
        return NotifyResult(NotifyStatus.SENT, message_id)

    def _send(self, chat_id: str, text: str) -> Optional[str]:
        """POST the message to Telegram (MarkdownV2). Returns the provider
        message id on success, or None on a permanent (4xx) rejection. Raises
        on transient failures (network error, Telegram 5xx) so notify() can
        mark the result retryable."""
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
        if resp.status_code >= 500:
            resp.raise_for_status()  # transient — let the caller retry
        logger.error("Telegram sendMessage failed: %s - %s", resp.status_code, resp.text)
        return None

    def _format(self, message: Message, classification: ClassificationResult) -> str:
        summary = classification.summary or ""
        if len(summary) > 500:
            summary = summary[:497] + "..."

        header = _attribution(message)

        first_line = (
            f"[{_md2_escape(header)}]({_url_escape(message.url)})"
            if message.url
            else _md2_escape(header)
        )

        return (
            f"{first_line}\n\n"
            f"{_md2_escape(summary)}"
        )


def _attribution(message: Message) -> str:
    """The text that goes on the first line of the notification."""
    _, addr = parseaddr(message.author or "")
    return addr or message.author or "email"


def _md2_escape(text: str) -> str:
    out = []
    for ch in text:
        if ch in _MD2_SPECIALS:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def _url_escape(url: str) -> str:
    return url.replace("\\", "\\\\").replace(")", "\\)")
