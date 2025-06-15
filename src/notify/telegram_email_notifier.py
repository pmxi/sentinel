from typing import Optional

from src.notify.email_notifier import EmailNotifier
from src.notify.telegram_notifier import TelegramNotifier
from src.classifier.email_classifier import ClassificationResult
from src.email.gmail.models import EmailData
from src.logging_config import get_logger

logger = get_logger(__name__)


class TelegramEmailNotifier(EmailNotifier):
    """Email notifier that formats and sends notifications via Telegram."""
    
    def __init__(self, telegram_notifier: TelegramNotifier):
        """Initialize with a Telegram notifier instance.
        
        Args:
            telegram_notifier: The base Telegram notifier to use for sending
        """
        self.notifier = telegram_notifier
    
    def notify(self, email: EmailData, classification: ClassificationResult) -> Optional[str]:
        """Format and send an email notification via Telegram.
        
        Args:
            email: The email data
            classification: The classification result
            
        Returns:
            Message ID if successful, None otherwise
        """
        try:
            # Format the message with Telegram markdown
            message = self._format_email_notification(email, classification)
            return self.notifier.send(message)
        except Exception as e:
            logger.error(f"Failed to send email notification: {e}")
            return None
    
    def _format_email_notification(self, email: EmailData, classification: ClassificationResult) -> str:
        """Format an email into a Telegram notification message.
        
        Args:
            email: The email data
            classification: The classification result
            
        Returns:
            Formatted message with Telegram MarkdownV2
        """
        # Get summary and truncate if needed
        summary = classification.summary or "No summary available"
        if len(summary) > 500:
            summary = summary[:497] + "\\.\\.\\."
        
        # Format the message with emojis and markdown
        message = (
            f"📧 *Important Email Alert*\n\n"
            f"*From:* {self._escape_markdown(email.sender)}\n"
            f"*Subject:* {self._escape_markdown(email.subject)}\n\n"
            f"*Summary:* {self._escape_markdown(summary)}"
        )
        
        return message
    
    def _escape_markdown(self, text: str) -> str:
        """Escape special characters for Telegram MarkdownV2.
        
        Args:
            text: Text to escape
            
        Returns:
            Escaped text safe for MarkdownV2
        """
        special_chars = [
            "_", "*", "[", "]", "(", ")", "~", "`", ">", "#",
            "+", "-", "=", "|", "{", "}", ".", "!"
        ]
        for char in special_chars:
            text = text.replace(char, f"\\{char}")
        return text