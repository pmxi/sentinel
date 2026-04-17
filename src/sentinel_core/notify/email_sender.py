"""Transactional email sender backed by Resend.

Thin wrapper around the Resend Python SDK. Not wired into the notifier/auth
stack yet; lives here ready for the first consumer (password reset, email
verification, or email-as-notification-channel).
"""

from typing import Optional

import resend

from sentinel_core.config import settings
from sentinel_core.logging_config import get_logger

logger = get_logger(__name__)


class EmailSender:
    """Sends transactional email via Resend."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        from_address: Optional[str] = None,
        from_name: str = "",
    ):
        self.api_key = api_key or settings.RESEND_API_KEY
        self.from_address = from_address or settings.EMAIL_FROM_ADDRESS
        self.from_name = from_name or settings.EMAIL_FROM_NAME

        if not self.api_key:
            raise ValueError("RESEND_API_KEY not configured")
        if not self.from_address:
            raise ValueError("EMAIL_FROM_ADDRESS not configured")

        resend.api_key = self.api_key

    def send(
        self,
        to: str,
        subject: str,
        html: str,
        text: Optional[str] = None,
    ) -> str:
        """Send one email. Returns the Resend message id."""
        from_field = (
            f"{self.from_name} <{self.from_address}>"
            if self.from_name
            else self.from_address
        )
        params: dict = {
            "from": from_field,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if text:
            params["text"] = text

        result = resend.Emails.send(params)
        message_id = result.get("id") if isinstance(result, dict) else getattr(result, "id", None)
        if not message_id:
            raise RuntimeError(f"Resend returned no id: {result!r}")
        logger.info("Sent email to=%s subject=%r id=%s", to, subject, message_id)
        return message_id
