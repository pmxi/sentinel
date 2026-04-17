from datetime import datetime
from typing import Any, Callable, List, Optional

from googleapiclient.discovery import build  # type: ignore

from sentinel_core.streams.email.gmail.models import email_data_from_gmail_message
from sentinel_core.streams.email.mail_config import MailAccountConfig
from sentinel_core.streams.email.models import EmailData
from sentinel_core.logging_config import get_logger

from ..email_client_base import EmailClient
from .auth import GmailAuth

logger = get_logger(__name__)


class GmailClient(EmailClient):
    def __init__(
        self,
        account_name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        """Initialize GmailClient.

        `on_token_refreshed` is called with the fresh token JSON string whenever
        the OAuth token is minted or refreshed, so the caller can persist it
        back to the database.
        """
        logger.debug(f"Initializing GmailClient for account '{account_name}'")
        super().__init__(account_name, config)
        if not config.auth.client_config_json:
            logger.error("client_config_json is required but not provided")
            raise ValueError("client_config_json is required")
        self.auth = GmailAuth(
            client_config_json=config.auth.client_config_json,
            token_json=config.auth.token_json,
            on_token_refreshed=on_token_refreshed,
        )
        self.service: Any = None
        self._connect()
        logger.info(f"GmailClient initialized successfully for account '{account_name}'")

    def _connect(self):
        """Initialize Gmail API service"""
        logger.debug("Connecting to Gmail API")
        try:
            creds = self.auth.get_credentials()
            self.service = build("gmail", "v1", credentials=creds)
            logger.info("Successfully connected to Gmail API")
        except Exception as e:
            logger.error(f"Failed to connect to Gmail API: {e}", exc_info=True)
            raise

    def get_unread_emails(self) -> List[EmailData]:
        """Fetch unread emails from inbox"""
        logger.debug("Fetching unread emails from inbox")
        try:
            results = (
                self.service.users()
                .messages()
                .list(userId="me", q="is:unread in:inbox")
                .execute()
            )

            messages = results.get("messages", [])
            logger.info(f"Found {len(messages)} unread messages")
            emails = []

            for message in messages:
                email_data = self._get_email_details(message["id"])
                if email_data:
                    emails.append(email_data)
                else:
                    logger.warning(f"Failed to get details for message {message['id']}")

            logger.info(f"Successfully retrieved {len(emails)} unread emails")
            return emails
        except Exception as e:
            logger.error(f"Failed to fetch unread emails: {str(e)}", exc_info=True)
            raise Exception(f"Failed to fetch emails: {str(e)}")

    def get_latest_email(self) -> Optional[EmailData]:
        """Get the most recent email from the inbox"""
        logger.debug("Fetching the latest email from inbox")
        try:
            results = (
                self.service.users()
                .messages()
                .list(userId="me", q="in:inbox")
                .execute()
            )

            messages = results.get("messages", [])
            if not messages:
                logger.info("No messages found in inbox")
                return None

            latest_message_id = messages[0]["id"]
            logger.debug(f"Found latest message with ID: {latest_message_id}")
            return self._get_email_details(latest_message_id)
        except Exception as e:
            logger.error(f"Error getting latest email: {e}", exc_info=True)
            return None

    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[EmailData]:
        """Get emails received after a specific timestamp"""
        logger.debug(f"Fetching emails after {after_timestamp}, unread_only={unread_only}")
        try:
            # Convert timestamp to seconds since epoch for Gmail query
            epoch_seconds = int(after_timestamp.timestamp())

            # Build query
            query_parts = [f"after:{epoch_seconds}"]
            if unread_only:
                query_parts.append("is:unread")
            query_parts.append("in:inbox")

            query = " ".join(query_parts)
            logger.debug(f"Gmail query: {query}")

            results = (
                self.service.users().messages().list(userId="me", q=query).execute()
            )

            messages = results.get("messages", [])
            logger.info(f"Found {len(messages)} messages matching criteria")
            emails = []

            for message in messages:
                email_data = self._get_email_details(message["id"])
                if email_data:
                    emails.append(email_data)
                else:
                    logger.warning(f"Failed to get details for message {message['id']}")

            logger.info(f"Successfully retrieved {len(emails)} emails after {after_timestamp}")
            return emails
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}", exc_info=True)
            raise

    def _get_email_details(self, message_id: str) -> Optional[EmailData]:
        """Get detailed email information"""
        logger.debug(f"Getting details for message {message_id}")
        try:
            message = (
                self.service.users()
                .messages()
                .get(userId="me", id=message_id)
                .execute()
            )

            email_data = email_data_from_gmail_message(message)
            email_data.provider = self.provider_type
            logger.debug(f"Retrieved email from {email_data.sender}, subject: {email_data.subject[:50]}...")
            return email_data
        except Exception as e:
            logger.error(f"Error getting email details for message {message_id}: {e}", exc_info=True)
            return None

    def mark_as_read(self, message_id: str):
        """Mark email as read"""
        logger.debug(f"Marking message {message_id} as read")
        try:
            self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": ["UNREAD"]}
            ).execute()
            logger.info(f"Successfully marked message {message_id} as read")
        except Exception as e:
            logger.error(f"Failed to mark message {message_id} as read: {str(e)}", exc_info=True)
            raise Exception(f"Failed to mark as read: {str(e)}")
