"""Shared email stream implementations."""

from sentinel_lib.streams.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel_lib.streams.email.stream import EmailStream

__all__ = [
    "AccountSettings",
    "AuthConfig",
    "AuthMethod",
    "EmailStream",
    "MailAccountConfig",
    "MailProvider",
]
