from typing import Callable, Dict, Optional, Type

from sentinel.logging_config import get_logger
from sentinel.streams.email.email_client_base import EmailClient
from sentinel.streams.email.gmail.client import GmailClient
from sentinel.streams.email.imap_client import IMAPClient
from sentinel.streams.email.mail_config import AuthMethod, MailAccountConfig, MailProvider

logger = get_logger(__name__)


class EmailClientFactory:
    """Factory for creating email clients based on configuration."""

    _provider_map: Dict[MailProvider, Type[EmailClient]] = {
        MailProvider.GMAIL_API: GmailClient,
        MailProvider.IMAP: IMAPClient,
    }

    @classmethod
    def create(
        cls,
        account_name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ) -> EmailClient:
        """Create an email client."""

        if not config.enabled:
            raise ValueError(f"Account {account_name} is disabled")

        if config.provider not in cls._provider_map:
            raise ValueError(f"Unsupported provider: {config.provider}")

        logger.info(f"Creating {config.provider} client for account: {account_name}")

        if config.provider == MailProvider.GMAIL_API:
            return cls._create_gmail_client(account_name, config, on_token_refreshed)
        return cls._create_imap_client(account_name, config)

    @classmethod
    def _create_gmail_client(
        cls,
        account_name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]],
    ) -> GmailClient:
        if config.auth.method != AuthMethod.OAUTH2:
            raise ValueError("Gmail API only supports OAuth2 authentication")
        if not config.auth.client_config_json:
            raise ValueError("Gmail API requires client_config_json")
        return GmailClient(account_name, config, on_token_refreshed)

    @classmethod
    def _create_imap_client(
        cls, account_name: str, config: MailAccountConfig
    ) -> IMAPClient:
        if not config.server:
            raise ValueError("IMAP provider requires server configuration")
        return IMAPClient(account_name, config)
