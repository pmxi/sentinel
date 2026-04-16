from enum import Enum
from typing import TYPE_CHECKING, Dict, List, Optional

from pydantic import BaseModel, model_validator

from sentinel.logging_config import get_logger

if TYPE_CHECKING:
    from sentinel.database import EmailDatabase

logger = get_logger(__name__)


class MailProvider(str, Enum):
    GMAIL_API = "gmail_api"
    IMAP = "imap"
    MSGRAPH = "msgraph"


class AuthMethod(str, Enum):
    OAUTH2 = "oauth2"
    PASSWORD = "password"


class AuthConfig(BaseModel):
    method: AuthMethod

    # OAuth2 fields — all inline strings, no file paths
    client_config_json: Optional[str] = None  # Gmail: contents of credentials.json
    token_json: Optional[str] = None          # OAuth authorized-user token
    client_id: Optional[str] = None           # MSGraph
    client_secret: Optional[str] = None
    tenant_id: Optional[str] = None

    # Password auth fields (IMAP)
    username: Optional[str] = None
    password: Optional[str] = None

    @model_validator(mode="after")
    def validate_auth_fields(self):
        if self.method == AuthMethod.OAUTH2:
            # Gmail API: needs client_config_json
            # MSGraph: needs client_id + tenant_id
            if not self.client_config_json and not self.client_id:
                raise ValueError(
                    "OAuth2 requires either client_config_json (Gmail) or client_id (MSGraph)"
                )
        elif self.method == AuthMethod.PASSWORD:
            if not self.username or not self.password:
                raise ValueError("username and password are required for password auth")
        return self


class AccountSettings(BaseModel):
    process_only_unread: bool = True
    max_lookback_hours: int = 24
    folders: List[str] = ["INBOX"]


class MailAccountConfig(BaseModel):
    provider: MailProvider
    auth: AuthConfig
    settings: AccountSettings = AccountSettings()
    enabled: bool = True

    # IMAP-specific fields
    server: Optional[str] = None
    port: Optional[int] = 993

    @model_validator(mode="after")
    def validate_provider_fields(self):
        if self.provider == MailProvider.IMAP and not self.server:
            raise ValueError("server is required for IMAP provider")
        return self

    class Config:
        use_enum_values = True


class MailboxesConfig(BaseModel):
    accounts: Dict[str, MailAccountConfig]

    def get_account(self, name: str) -> Optional[MailAccountConfig]:
        return self.accounts.get(name)

    def get_enabled_accounts(self) -> Dict[str, MailAccountConfig]:
        return {name: acc for name, acc in self.accounts.items() if acc.enabled}

    @classmethod
    def from_db(cls, db: "EmailDatabase") -> "MailboxesConfig":
        """Load configuration from the accounts table."""
        rows = db.list_accounts()
        accounts: Dict[str, MailAccountConfig] = {}
        for name, config_json in rows.items():
            try:
                accounts[name] = MailAccountConfig.model_validate_json(config_json)
            except Exception as e:
                logger.error(f"Failed to parse account '{name}': {e}")
                raise
        config = cls(accounts=accounts)
        logger.info(f"Loaded {len(accounts)} mail accounts from database")
        for name, account in accounts.items():
            logger.info(
                f"  - {name}: {account.provider} (enabled: {account.enabled})"
            )
        return config
