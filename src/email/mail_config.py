from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from pydantic import BaseModel, field_validator, model_validator

from src.logging_config import get_logger

logger = get_logger(__name__)


class MailProvider(str, Enum):
    GMAIL_API = "gmail_api"
    IMAP = "imap"


class AuthMethod(str, Enum):
    OAUTH2 = "oauth2"
    PASSWORD = "password"


class AuthConfig(BaseModel):
    method: AuthMethod

    # OAuth2 fields
    credentials_file: Optional[Path] = None
    token_file: Optional[Path] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    tenant_id: Optional[str] = None

    # Password auth fields
    username: Optional[str] = None
    password: Optional[str] = None

    @field_validator("credentials_file", "token_file", mode="before")
    @classmethod
    def validate_paths(cls, v):
        if v and not isinstance(v, Path):
            return Path(v)
        return v

    @model_validator(mode="after")
    def validate_auth_fields(self):
        if self.method == AuthMethod.OAUTH2:
            # For Gmail API, we need credentials_file
            if self.credentials_file and not self.token_file:
                raise ValueError("token_file is required when using credentials_file")
            # For IMAP OAuth2, we need client_id
            elif self.client_id and not self.token_file:
                raise ValueError("token_file is required when using OAuth2")
            elif not self.credentials_file and not self.client_id:
                raise ValueError(
                    "Either credentials_file or client_id is required for OAuth2"
                )

        elif self.method == AuthMethod.PASSWORD:
            if not self.username or not self.password:
                raise ValueError("username and password are required for password auth")

        return self


class AccountSettings(BaseModel):
    process_only_unread: bool = True
    max_lookback_hours: int = 24
    folders: List[str] = ["INBOX"]
    junk_folder_name: str = "Junk"  # Configurable name for junk/spam folder


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
        if self.provider == MailProvider.IMAP:
            if not self.server:
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
    def from_yaml(cls, config_path: str = "config/mailboxes.yaml") -> "MailboxesConfig":
        """Load configuration from YAML file"""
        config_file = Path(config_path)

        if not config_file.exists():
            raise FileNotFoundError(f"Configuration file not found: {config_path}")

        logger.info(f"Loading mail configuration from {config_path}")

        try:
            with open(config_file, "r") as f:
                raw_config = yaml.safe_load(f)

            config = cls(**raw_config)

            logger.info(f"Loaded {len(config.accounts)} mail accounts")
            for name, account in config.accounts.items():
                logger.info(
                    f"  - {name}: {account.provider} (enabled: {account.enabled})"
                )

            return config

        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in configuration file: {e}")
        except Exception as e:
            logger.error(f"Error loading configuration: {e}")
            raise
