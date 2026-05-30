"""Email ingestion: polling clients (IMAP, Gmail) behind an EmailStream."""

from sentinel.email.mail_config import AccountSettings, AuthConfig, AuthMethod, MailAccountConfig, MailProvider
from sentinel.email.stream import EmailStream

__all__ = [
    "AccountSettings",
    "AuthConfig",
    "AuthMethod",
    "EmailStream",
    "MailAccountConfig",
    "MailProvider",
]
