from typing import TYPE_CHECKING, Callable, Dict, Optional, Type

from sentinel.email.email_client_base import EmailClient
from sentinel.email.gmail.client import GmailClient
from sentinel.email.imap_client import IMAPClient
from sentinel.email.mail_config import AuthMethod, MailAccountConfig, MailProvider
from sentinel.email.msgraph_client import MSGraphClient
from sentinel.logging_config import get_logger

if TYPE_CHECKING:
    from sentinel.database import EmailDatabase

logger = get_logger(__name__)


class EmailClientFactory:
    """Factory for creating email clients based on configuration."""

    _provider_map: Dict[MailProvider, Type[EmailClient]] = {
        MailProvider.GMAIL_API: GmailClient,
        MailProvider.IMAP: IMAPClient,
        MailProvider.MSGRAPH: MSGraphClient,
    }

    @classmethod
    def create(
        cls,
        account_name: str,
        config: MailAccountConfig,
        db: Optional["EmailDatabase"] = None,
    ) -> EmailClient:
        """Create an email client. If `db` is provided, OAuth token refreshes
        are persisted back into the accounts table automatically."""

        if not config.enabled:
            raise ValueError(f"Account {account_name} is disabled")

        provider_class = cls._provider_map.get(config.provider)
        if not provider_class:
            raise ValueError(f"Unsupported provider: {config.provider}")

        logger.info(f"Creating {config.provider} client for account: {account_name}")

        on_token_refreshed = (
            cls._make_token_persister(db, account_name, config) if db else None
        )

        if config.provider == MailProvider.GMAIL_API:
            return cls._create_gmail_client(account_name, config, on_token_refreshed)
        elif config.provider == MailProvider.IMAP:
            return cls._create_imap_client(account_name, config)
        elif config.provider == MailProvider.MSGRAPH:
            return cls._create_msgraph_client(account_name, config, on_token_refreshed)
        else:
            raise ValueError(f"No factory method for provider: {config.provider}")

    @staticmethod
    def _make_token_persister(
        db: "EmailDatabase", account_name: str, config: MailAccountConfig
    ) -> Callable[[str], None]:
        """Return a callback that updates config.auth.token_json and writes
        the account row back to the database."""

        def persist(token_json: str) -> None:
            config.auth.token_json = token_json
            db.upsert_account(account_name, config.model_dump_json())
            logger.debug(f"Persisted refreshed token for account '{account_name}'")

        return persist

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

    @classmethod
    def _create_msgraph_client(
        cls,
        account_name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]],
    ) -> MSGraphClient:
        if config.auth.method != AuthMethod.OAUTH2:
            raise ValueError("Microsoft Graph API only supports OAuth2 authentication")
        if not config.auth.client_id or not config.auth.tenant_id:
            raise ValueError("Microsoft Graph API requires client_id and tenant_id")
        return MSGraphClient(account_name, config, on_token_refreshed)
