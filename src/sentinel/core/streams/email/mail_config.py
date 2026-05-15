from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, model_validator


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

