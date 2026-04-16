from email.utils import parseaddr
from typing import Optional

from sentinel.classifier.email_classifier import ClassificationResult
from sentinel.email.models import EmailData
from sentinel.logging_config import get_logger
from sentinel.notify.email_notifier import EmailNotifier
from sentinel.notify.telegram_notifier import TelegramNotifier

logger = get_logger(__name__)

# MarkdownV2 reserved characters (outside link URLs).
_MD2_SPECIALS = r"_*[]()~`>#+-=|{}.!"


class TelegramEmailNotifier(EmailNotifier):
    """Formats important-email alerts for Telegram.

    Layout (lean — the first line is what shows on small previews like an
    Apple Watch, so every character counts):

        <sender_email>     (tappable link to the message if provider gives one)

        <subject>

        <summary>

    No labels, no emoji. If the EmailData lacks a deep link, the sender
    renders as plain text (Telegram will auto-link it as mailto:, which is
    an acceptable fallback).
    """

    def __init__(self, telegram_notifier: TelegramNotifier):
        self.notifier = telegram_notifier

    def notify(
        self, email: EmailData, classification: ClassificationResult
    ) -> Optional[str]:
        try:
            message = self._format_email_notification(email, classification)
            return self.notifier.send(message)
        except Exception as e:
            logger.error(f"Failed to send email notification: {e}")
            return None

    def _format_email_notification(
        self, email: EmailData, classification: ClassificationResult
    ) -> str:
        summary = classification.summary or ""
        if len(summary) > 500:
            summary = summary[:497] + "..."

        _, addr = parseaddr(email.sender)
        sender = addr or email.sender

        sender_text = _md2_escape(sender)
        first_line = (
            f"[{sender_text}]({_url_escape(email.url)})"
            if email.url
            else sender_text
        )

        return (
            f"{first_line}\n\n"
            f"{_md2_escape(email.subject)}\n\n"
            f"{_md2_escape(summary)}"
        )


def _md2_escape(text: str) -> str:
    """Escape MarkdownV2 reserved characters outside link URLs."""
    out = []
    for ch in text:
        if ch in _MD2_SPECIALS:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def _url_escape(url: str) -> str:
    """Inside a MarkdownV2 link URL only ')' and '\\' must be escaped."""
    return url.replace("\\", "\\\\").replace(")", "\\)")
