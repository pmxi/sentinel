from datetime import datetime
from typing import Any, Callable, List, Optional

from googleapiclient.discovery import build  # type: ignore

from sentinel.logging_config import get_logger
from sentinel.email.email_client_base import EmailClient
from sentinel.email.gmail.auth import GmailAuth
from sentinel.email.gmail.models import email_data_from_gmail_message
from sentinel.email.mail_config import MailAccountConfig
from sentinel.email.models import EmailData

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
            logger.debug(f"Retrieved email from {email_data.sender}, subject: {email_data.subject[:50]}...")
            return email_data
        except Exception as e:
            logger.error(f"Error getting email details for message {message_id}: {e}", exc_info=True)
            return None
