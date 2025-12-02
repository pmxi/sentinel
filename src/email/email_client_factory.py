from typing import Dict, Type

from src.email.email_client_base import EmailClient
from src.email.gmail.client import GmailClient
from src.email.imap_client import IMAPClient
from src.email.mail_config import AuthMethod, MailAccountConfig, MailProvider
from src.email.msgraph_client import MSGraphClient
from src.logging_config import get_logger

logger = get_logger(__name__)


class EmailClientFactory:
    """Factory for creating email clients based on configuration"""

    _provider_map: Dict[MailProvider, Type[EmailClient]] = {
        MailProvider.GMAIL_API: GmailClient,
        MailProvider.IMAP: IMAPClient,
        MailProvider.MSGRAPH: MSGraphClient,
    }

    @classmethod
    def create(cls, account_name: str, config: MailAccountConfig) -> EmailClient:
        """Create an email client instance from configuration"""

        if not config.enabled:
            raise ValueError(f"Account {account_name} is disabled")

        provider_class = cls._provider_map.get(config.provider)
        if not provider_class:
            raise ValueError(f"Unsupported provider: {config.provider}")

        logger.info(f"Creating {config.provider} client for account: {account_name}")

        # Provider-specific initialization
        if config.provider == MailProvider.GMAIL_API:
            return cls._create_gmail_client(account_name, config)
        elif config.provider == MailProvider.IMAP:
            return cls._create_imap_client(account_name, config)
        elif config.provider == MailProvider.MSGRAPH:
            return cls._create_msgraph_client(account_name, config)
        else:
            raise ValueError(f"No factory method for provider: {config.provider}")

    @classmethod
    def _create_gmail_client(
        cls, account_name: str, config: MailAccountConfig
    ) -> GmailClient:
        """Create Gmail API client"""
        if config.auth.method != AuthMethod.OAUTH2:
            raise ValueError("Gmail API only supports OAuth2 authentication")

        if not config.auth.credentials_file or not config.auth.token_file:
            raise ValueError("Gmail API requires credentials_file and token_file")

        # Initialize GmailClient with account_name and config for consistent injection
        return GmailClient(account_name, config)

    @classmethod
    def _create_imap_client(
        cls, account_name: str, config: MailAccountConfig
    ) -> IMAPClient:
        """Create IMAP client"""
        if not config.server:
            raise ValueError("IMAP provider requires server configuration")

        return IMAPClient(account_name, config)

    @classmethod
    def _create_msgraph_client(
        cls, account_name: str, config: MailAccountConfig
    ) -> MSGraphClient:
        """Create Microsoft Graph API client"""
        if config.auth.method != AuthMethod.OAUTH2:
            raise ValueError("Microsoft Graph API only supports OAuth2 authentication")

        if not config.auth.client_id or not config.auth.tenant_id:
            raise ValueError("Microsoft Graph API requires client_id and tenant_id")

        if not config.auth.token_file:
            raise ValueError("Microsoft Graph API requires token_file for token caching")

        return MSGraphClient(account_name, config)
