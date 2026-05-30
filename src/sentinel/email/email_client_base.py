from abc import ABC, abstractmethod
from datetime import datetime
from typing import List

from sentinel.email.mail_config import MailAccountConfig
from sentinel.email.models import EmailData


class EmailClient(ABC):
    """Abstract base class for email clients"""

    def __init__(self, account_name: str, config: MailAccountConfig):
        """
        Initialize with the account name and its MailAccountConfig.
        """
        self.account_name = account_name
        self.config = config

    @abstractmethod
    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[EmailData]:
        """Get emails received after a specific timestamp"""
        pass

    def close(self) -> None:
        """Release any underlying resources held by the client."""
        return None
