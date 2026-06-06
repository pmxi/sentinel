from enum import Enum
from typing import Optional

from pydantic import BaseModel, model_validator


class MailProvider(str, Enum):
    GMAIL_API = "gmail_api"
    IMAP = "imap"


class AuthMethod(str, Enum):
    OAUTH2 = "oauth2"
    PASSWORD = "password"


class AuthConfig(BaseModel):
    method: AuthMethod

    # OAuth2 fields (Gmail) — all inline strings, no file paths
    client_config_json: Optional[str] = None  # contents of the OAuth client JSON
    token_json: Optional[str] = None          # OAuth authorized-user token

    # Password auth fields (IMAP)
    username: Optional[str] = None
    password: Optional[str] = None

    @model_validator(mode="after")
    def validate_auth_fields(self):
        if self.method == AuthMethod.OAUTH2:
            if not self.client_config_json:
                raise ValueError("OAuth2 requires client_config_json (Gmail)")
        elif self.method == AuthMethod.PASSWORD:
            if not self.username or not self.password:
                raise ValueError("username and password are required for password auth")
        return self


class AccountSettings(BaseModel):
    process_only_unread: bool = True
    max_lookback_hours: int = 24


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
            if self.auth.method == AuthMethod.OAUTH2:
                raise ValueError("IMAP provider supports password auth only; OAuth2 is not implemented")
        return self

    class Config:
        use_enum_values = True

