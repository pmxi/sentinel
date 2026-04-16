"""Microsoft Graph API email client."""

import asyncio
from datetime import datetime
from typing import Any, Callable, List, Optional

from azure.identity import (
    AuthenticationRecord,
    DeviceCodeCredential,
    InteractiveBrowserCredential,
    TokenCachePersistenceOptions,
)
from msgraph import GraphServiceClient
from msgraph.generated.models.message import Message

from src.email.email_client_base import EmailClient
from src.email.mail_config import MailAccountConfig
from src.email.models import EmailData
from src.logging_config import get_logger

logger = get_logger(__name__)

SCOPES = ["https://graph.microsoft.com/Mail.ReadWrite"]


class MSGraphClient(EmailClient):
    """Microsoft Graph API email client for Office 365/Outlook."""

    def __init__(
        self,
        account_name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        """Initialize MSGraphClient.

        `on_token_refreshed` is called with the serialized AuthenticationRecord
        whenever a new record is minted, so the caller can persist it.
        """
        logger.debug(f"Initializing MSGraphClient for account '{account_name}'")
        super().__init__(account_name, config)

        if not config.auth.client_id:
            logger.error("client_id is required but not provided")
            raise ValueError("client_id is required for Microsoft Graph")
        if not config.auth.tenant_id:
            logger.error("tenant_id is required but not provided")
            raise ValueError("tenant_id is required for Microsoft Graph")

        self.client_id = config.auth.client_id
        self.tenant_id = config.auth.tenant_id
        self.auth_record_json = config.auth.token_json
        self.on_token_refreshed = on_token_refreshed

        self.client: Optional[GraphServiceClient] = None
        self._connect()
        logger.info(f"MSGraphClient initialized successfully for account '{account_name}'")

    def _connect(self):
        """Initialize Microsoft Graph client with authentication."""
        logger.debug("Connecting to Microsoft Graph API")
        try:
            credential = self._get_credential()
            self.client = GraphServiceClient(credentials=credential, scopes=SCOPES)
            logger.info("Successfully connected to Microsoft Graph API")
        except Exception as e:
            logger.error(f"Failed to connect to Microsoft Graph API: {e}", exc_info=True)
            raise

    def _get_credential(self) -> Any:
        """Get Azure credential with token caching."""
        # Enable persistent token cache
        cache_options = TokenCachePersistenceOptions(
            name="msgraph_token_cache",
            allow_unencrypted_storage=True,
        )

        # Load authentication record if it exists (for silent auth)
        auth_record = self._load_auth_record()

        # Try browser-based auth first, fall back to device code
        try:
            logger.debug("Attempting interactive browser authentication")
            credential = InteractiveBrowserCredential(
                client_id=self.client_id,
                tenant_id=self.tenant_id,
                cache_persistence_options=cache_options,
                authentication_record=auth_record,
            )
            # Test the credential and save auth record
            if not auth_record:
                record = credential.authenticate(scopes=SCOPES)
                self._save_auth_record(record)
            return credential
        except Exception as e:
            logger.debug(f"Browser auth failed ({e}), falling back to device code flow")
            credential = DeviceCodeCredential(
                client_id=self.client_id,
                tenant_id=self.tenant_id,
                cache_persistence_options=cache_options,
                authentication_record=auth_record,
            )
            if not auth_record:
                record = credential.authenticate(scopes=SCOPES)
                self._save_auth_record(record)
            return credential

    def _load_auth_record(self) -> Optional[AuthenticationRecord]:
        """Deserialize the stored AuthenticationRecord string, if any."""
        if self.auth_record_json:
            try:
                return AuthenticationRecord.deserialize(self.auth_record_json)
            except Exception as e:
                logger.debug(f"Could not load auth record: {e}")
        return None

    def _save_auth_record(self, record: AuthenticationRecord):
        """Persist the AuthenticationRecord via the on_token_refreshed callback."""
        try:
            serialized = record.serialize()
            self.auth_record_json = serialized
            if self.on_token_refreshed:
                self.on_token_refreshed(serialized)
            logger.debug("Persisted MSGraph auth record")
        except Exception as e:
            logger.warning(f"Could not save auth record: {e}")

    def _run_async(self, coro):
        """Run async coroutine synchronously."""
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)

    def get_unread_emails(self) -> List[EmailData]:
        """Fetch unread emails from inbox."""
        logger.debug("Fetching unread emails from inbox")
        try:
            result = self._run_async(
                self.client.me.mail_folders.by_mail_folder_id("inbox")
                .messages.get(
                    request_configuration=lambda config: setattr(
                        config.query_parameters, "filter", "isRead eq false"
                    )
                    or setattr(config.query_parameters, "top", 50)
                    or setattr(
                        config.query_parameters,
                        "select",
                        ["id", "subject", "from", "toRecipients", "body", "receivedDateTime", "isRead"],
                    )
                )
            )

            messages = result.value if result else []
            logger.info(f"Found {len(messages)} unread messages")

            emails = [self._parse_message(msg) for msg in messages]
            logger.info(f"Successfully retrieved {len(emails)} unread emails")
            return emails
        except Exception as e:
            logger.error(f"Failed to fetch unread emails: {str(e)}", exc_info=True)
            raise Exception(f"Failed to fetch emails: {str(e)}")

    def get_latest_email(self) -> Optional[EmailData]:
        """Get the most recent email from the inbox."""
        logger.debug("Fetching the latest email from inbox")
        try:
            result = self._run_async(
                self.client.me.mail_folders.by_mail_folder_id("inbox")
                .messages.get(
                    request_configuration=lambda config: setattr(
                        config.query_parameters, "top", 1
                    )
                    or setattr(config.query_parameters, "orderby", ["receivedDateTime desc"])
                    or setattr(
                        config.query_parameters,
                        "select",
                        ["id", "subject", "from", "toRecipients", "body", "receivedDateTime", "isRead"],
                    )
                )
            )

            messages = result.value if result else []
            if not messages:
                logger.info("No messages found in inbox")
                return None

            email = self._parse_message(messages[0])
            logger.debug(f"Found latest message from {email.sender}, subject: {email.subject[:50]}...")
            return email
        except Exception as e:
            logger.error(f"Error getting latest email: {e}", exc_info=True)
            return None

    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[EmailData]:
        """Get emails received after a specific timestamp."""
        logger.debug(f"Fetching emails after {after_timestamp}, unread_only={unread_only}")
        try:
            # Convert to ISO 8601 format for Graph API
            iso_timestamp = after_timestamp.strftime("%Y-%m-%dT%H:%M:%SZ")

            filter_parts = [f"receivedDateTime gt {iso_timestamp}"]
            if unread_only:
                filter_parts.append("isRead eq false")
            filter_query = " and ".join(filter_parts)

            logger.debug(f"Graph API filter: {filter_query}")

            result = self._run_async(
                self.client.me.mail_folders.by_mail_folder_id("inbox")
                .messages.get(
                    request_configuration=lambda config: setattr(
                        config.query_parameters, "filter", filter_query
                    )
                    or setattr(config.query_parameters, "orderby", ["receivedDateTime desc"])
                    or setattr(
                        config.query_parameters,
                        "select",
                        ["id", "subject", "from", "toRecipients", "body", "receivedDateTime", "isRead"],
                    )
                )
            )

            messages = result.value if result else []
            logger.info(f"Found {len(messages)} messages matching criteria")

            emails = [self._parse_message(msg) for msg in messages]
            logger.info(f"Successfully retrieved {len(emails)} emails after {after_timestamp}")
            return emails
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}", exc_info=True)
            return []

    def mark_as_read(self, message_id: str):
        """Mark email as read."""
        logger.debug(f"Marking message {message_id} as read")
        try:
            update_message = Message(is_read=True)
            self._run_async(
                self.client.me.messages.by_message_id(message_id).patch(update_message)
            )
            logger.info(f"Successfully marked message {message_id} as read")
        except Exception as e:
            logger.error(f"Failed to mark message {message_id} as read: {str(e)}", exc_info=True)
            raise Exception(f"Failed to mark as read: {str(e)}")

    def _parse_message(self, msg: Message) -> EmailData:
        """Convert Graph API message to EmailData."""
        sender = "Unknown"
        if msg.from_ and msg.from_.email_address:
            sender = msg.from_.email_address.address or "Unknown"

        recipient = "Unknown"
        if msg.to_recipients and len(msg.to_recipients) > 0:
            first_recipient = msg.to_recipients[0]
            if first_recipient.email_address:
                recipient = first_recipient.email_address.address or "Unknown"

        body = ""
        if msg.body:
            body = msg.body.content or ""

        return EmailData(
            id=msg.id or "",
            subject=msg.subject or "No Subject",
            sender=sender,
            recipient=recipient,
            body=body,
            received_date=msg.received_date_time.isoformat() if msg.received_date_time else "Unknown",
            is_read=msg.is_read or False,
            provider=self.provider_type,
        )
