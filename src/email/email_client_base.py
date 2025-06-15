from abc import ABC, abstractmethod
from datetime import datetime
from typing import List, Optional

from .gmail.models import EmailData
from .mail_config import MailAccountConfig


class EmailClient(ABC):
    """Abstract base class for email clients"""

    def __init__(self, account_name: str, config: MailAccountConfig):
        """
        Initialize with the account name and its MailAccountConfig.
        """
        self.account_name = account_name
        self.config = config
        self.provider_type = config.provider  # e.g., 'gmail_api', 'imap'

    @abstractmethod
    def get_unread_emails(self) -> List[EmailData]:
        """Fetch unread emails from inbox"""
        pass

    @abstractmethod
    def get_latest_email(self) -> Optional[EmailData]:
        """Get the most recent email from the inbox"""
        pass

    @abstractmethod
    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[EmailData]:
        """Get emails received after a specific timestamp"""
        pass

    @abstractmethod
    def mark_as_read(self, message_id: str):
        """Mark email as read"""
        pass

    @abstractmethod
    def move_to_junk(self, message_id: str):
        """Move email to junk folder"""
        pass
