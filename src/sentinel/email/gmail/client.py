import base64
from datetime import datetime
from typing import Any, Callable, List, Optional

from googleapiclient.discovery import build

from sentinel.item import Item
from sentinel.logging_config import get_logger
from sentinel.email.email_client_base import EmailClient, build_email_item
from sentinel.email.gmail.auth import GmailAuth
from sentinel.email.mail_config import MailAccountConfig

logger = get_logger(__name__)


def _extract_body(payload: dict) -> str:
    """Recursively pull the text/plain body out of a Gmail message payload.

    Descends nested MIME parts (e.g. multipart/mixed wrapping multipart/
    alternative) and tolerates parts with no inline data, such as attachments.
    Returns "" if no text/plain part is found."""
    data = (payload.get("body") or {}).get("data")
    if payload.get("mimeType") == "text/plain" and data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
    for part in payload.get("parts") or []:
        text = _extract_body(part)
        if text:
            return text
    return ""


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
    ) -> List[Item]:
        """Get items for emails received after a specific timestamp"""
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
            items = []

            for message in messages:
                item = self._get_email_details(message["id"])
                if item:
                    items.append(item)
                else:
                    logger.warning(f"Failed to get details for message {message['id']}")

            logger.info(f"Successfully retrieved {len(items)} emails after {after_timestamp}")
            return items
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}", exc_info=True)
            raise

    def _get_email_details(self, message_id: str) -> Optional[Item]:
        """Fetch a message and convert it to an Item."""
        logger.debug(f"Getting details for message {message_id}")
        try:
            message = (
                self.service.users()
                .messages()
                .get(userId="me", id=message_id)
                .execute()
            )

            headers = message["payload"]["headers"]

            def header(name: str, default: str) -> str:
                return next((h["value"] for h in headers if h["name"] == name), default)

            # Deep link into the Gmail web UI; /u/0/ targets the primary account.
            thread_id = message.get("threadId")
            url = f"https://mail.google.com/mail/u/0/#inbox/{thread_id}" if thread_id else None

            item = build_email_item(
                stream_name=self.account_name,
                provider=self.config.provider,
                msg_id=message["id"],
                subject=header("Subject", "No Subject"),
                sender=header("From", "Unknown Sender"),
                recipient=header("To", "Unknown Recipient"),
                received_date=header("Date", "Unknown Date"),
                body=_extract_body(message["payload"]),
                url=url,
            )
            logger.debug(f"Retrieved email from {item.author}, subject: {item.title[:50]}...")
            return item
        except Exception as e:
            logger.error(f"Error getting email details for message {message_id}: {e}", exc_info=True)
            return None
