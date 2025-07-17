from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

from googleapiclient.discovery import build  # type: ignore

from src.email.gmail.models import email_data_from_gmail_message
from src.email.mail_config import MailAccountConfig
from src.email.models import EmailData
from src.logging_config import get_logger

from ..email_client_base import EmailClient
from .auth import GmailAuth  # will now accept injected paths

logger = get_logger(__name__)


class GmailClient(EmailClient):
    def __init__(self, account_name: str, config: MailAccountConfig):
        """Initialize GmailClient with the account name and its MailAccountConfig."""
        logger.debug(f"Initializing GmailClient for account '{account_name}'")
        # Initialize base with account_name and config
        super().__init__(account_name, config)
        # credentials_file and token_file were validated by factory
        if not config.auth.credentials_file:
            logger.error("credentials_file is required but not provided")
            raise ValueError("credentials_file is required")
        if not config.auth.token_file:
            logger.error("token_file is required but not provided")
            raise ValueError("token_file is required")
        creds_file: Path = config.auth.credentials_file  # type: ignore
        token_file: Path = config.auth.token_file  # type: ignore
        logger.debug(f"Using credentials file: {creds_file}")
        logger.debug(f"Using token file: {token_file}")
        # Inject credential and token paths into GmailAuth
        self.auth = GmailAuth(creds_file, token_file)
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
            return []

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

    def move_to_junk(self, message_id: str):
        """Move email to junk folder"""
        logger.debug(f"Moving message {message_id} to junk folder")
        try:
            # Create junk label if it doesn't exist
            self._ensure_junk_label()

            # Add junk label and remove inbox label
            junk_label_id = self._get_junk_label_id()
            logger.debug(f"Using junk label ID: {junk_label_id}")
            
            self.service.users().messages().modify(
                userId="me",
                id=message_id,
                body={
                    "addLabelIds": [junk_label_id],
                    "removeLabelIds": ["INBOX"],
                },
            ).execute()
            logger.info(f"Successfully moved message {message_id} to junk folder")
        except Exception as e:
            logger.error(f"Failed to move email to junk: {str(e)}", exc_info=True)
            raise Exception(f"Failed to move email to junk: {str(e)}")

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

    def _ensure_junk_label(self):
        """Create junk label if it doesn't exist"""
        junk_folder_name = self.config.settings.junk_folder_name
        logger.debug(f"Ensuring junk label '{junk_folder_name}' exists")
        try:
            labels = self.service.users().labels().list(userId="me").execute()
            label_names = [label["name"] for label in labels.get("labels", [])]

            if junk_folder_name not in label_names:
                logger.info(f"Junk label '{junk_folder_name}' not found, creating it")
                label_object = {
                    "name": junk_folder_name,
                    "messageListVisibility": "show",
                    "labelListVisibility": "labelShow",
                }
                self.service.users().labels().create(
                    userId="me", body=label_object
                ).execute()
                logger.info(f"Successfully created junk label '{junk_folder_name}'")
            else:
                logger.debug(f"Junk label '{junk_folder_name}' already exists")
        except Exception as e:
            logger.error(f"Failed to create junk label: {str(e)}", exc_info=True)
            raise Exception(f"Failed to create junk label: {str(e)}")

    def _get_junk_label_id(self) -> str:
        """Get the ID of the junk label"""
        junk_folder_name = self.config.settings.junk_folder_name
        logger.debug(f"Getting junk label ID for '{junk_folder_name}'")
        try:
            labels = self.service.users().labels().list(userId="me").execute()
            for label in labels.get("labels", []):
                if label["name"] == junk_folder_name:
                    logger.debug(f"Found junk label '{junk_folder_name}' with ID: {label['id']}")
                    return label["id"]
            logger.error(f"Junk label '{junk_folder_name}' not found in label list")
            raise Exception(f"Junk label '{junk_folder_name}' not found")
        except Exception as e:
            logger.error(f"Failed to get junk label ID: {str(e)}", exc_info=True)
            raise Exception(f"Failed to get junk label ID: {str(e)}")
