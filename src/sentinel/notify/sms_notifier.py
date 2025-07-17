from typing import Optional

from twilio.rest import Client

from sentinel.logging_config import get_logger
from sentinel.notify.notifier import Notifier

logger = get_logger(__name__)


class SMSNotifier(Notifier):
    """Notifier class for sending notifications via Twilio SMS."""

    def __init__(
        self, account_sid: str, auth_token: str, from_number: str, to_number: str
    ):
        """Initialize the notifier with Twilio credentials.

        Args:
            account_sid: Twilio account SID
            auth_token: Twilio auth token
            from_number: Phone number to send from
            to_number: Phone number to send to
        """
        if not account_sid:
            raise ValueError("account_sid is required")
        if not auth_token:
            raise ValueError("auth_token is required")
        if not from_number:
            raise ValueError("from_number is required")
        if not to_number:
            raise ValueError("to_number is required")

        self.client = Client(account_sid, auth_token)
        self.from_number = from_number
        self.to_number = to_number

    def send(self, text: str) -> Optional[str]:
        """Send a text message via SMS.

        Args:
            text: The message to send

        Returns:
            The message SID if successful, None if failed
        """
        try:
            # SMS has 160 character limit, truncate if needed
            if len(text) > 160:
                text = text[:157] + "..."

            message = self.client.messages.create(
                body=text,
                from_=self.from_number,
                to=self.to_number,
            )
            return message.sid
        except Exception as e:
            logger.error(f"Failed to send SMS notification: {e}")
            return None
