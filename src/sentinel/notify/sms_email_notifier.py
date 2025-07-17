from typing import Optional

from sentinel.notify.email_notifier import EmailNotifier
from sentinel.notify.sms_notifier import SMSNotifier
from sentinel.classifier.email_classifier import ClassificationResult
from sentinel.email.gmail.models import EmailData
from sentinel.logging_config import get_logger

logger = get_logger(__name__)


class SMSEmailNotifier(EmailNotifier):
    """Email notifier that formats and sends notifications via SMS."""

    def __init__(self, sms_notifier: SMSNotifier):
        """Initialize with an SMS notifier instance.

        Args:
            sms_notifier: The base SMS notifier to use for sending
        """
        self.notifier = sms_notifier

    def notify(
        self, email: EmailData, classification: ClassificationResult
    ) -> Optional[str]:
        """Format and send an email notification via SMS.

        Args:
            email: The email data
            classification: The classification result

        Returns:
            Message SID if successful, None otherwise
        """
        try:
            # Format the message for SMS (concise due to 160 char limit)
            message = self._format_email_notification(email, classification)
            return self.notifier.send(message)
        except Exception as e:
            logger.error(f"Failed to send email notification: {e}")
            return None

    def _format_email_notification(
        self, email: EmailData, classification: ClassificationResult
    ) -> str:
        """Format an email into a concise SMS notification.

        Args:
            email: The email data
            classification: The classification result

        Returns:
            Formatted message suitable for SMS
        """
        # Extract sender name (before email address)
        sender = email.sender.split("<")[0].strip()
        if len(sender) > 20:
            sender = sender[:17] + "..."

        # Get summary - very short for SMS
        summary = classification.summary or "Important email"
        if len(summary) > 60:
            summary = summary[:57] + "..."

        # Format concise message
        message = f"Email from {sender}: {summary}"

        return message
