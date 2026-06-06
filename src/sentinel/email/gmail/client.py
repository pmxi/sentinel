import base64
from datetime import datetime
from typing import Any, Callable, List, Optional

from googleapiclient.discovery import build

from sentinel.message import Message, build_message
from sentinel.logging_config import get_logger
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


class GmailClient:
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
        self.account_name = account_name
        self.config = config
        self.auth = GmailAuth(
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

    def close(self) -> None:
        """Release the service's underlying HTTP transport. Best-effort: the
        googleapiclient service holds httplib2 connections on `_http`."""
        http = getattr(self.service, "_http", None)
        self.service = None
        for obj in (http, getattr(http, "http", None)):
            closer = getattr(obj, "close", None)
            if callable(closer):
                try:
                    closer()
                except Exception as e:
                    logger.debug(f"Error closing Gmail transport: {e}")

    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[Message]:
        """Get messages for emails received after a specific timestamp"""
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

            refs = results.get("messages", [])
            logger.info(f"Found {len(refs)} messages matching criteria")
            messages: List[Message] = []

            for ref in refs:
                message = self._get_email_details(ref["id"])
                if message:
                    messages.append(message)
                else:
                    logger.warning(f"Failed to get details for message {ref['id']}")

            logger.info(f"Successfully retrieved {len(messages)} emails after {after_timestamp}")
            return messages
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}", exc_info=True)
            raise

    def _get_email_details(self, message_id: str) -> Optional[Message]:
        """Fetch an email and convert it to a Message."""
        logger.debug(f"Getting details for message {message_id}")
        try:
            raw = (
                self.service.users()
                .messages()
                .get(userId="me", id=message_id)
                .execute()
            )

            headers = raw["payload"]["headers"]

            def header(name: str, default: str) -> str:
                return next((h["value"] for h in headers if h["name"] == name), default)

            # Deep link into the Gmail web UI; /u/0/ targets the primary account.
            thread_id = raw.get("threadId")
            url = f"https://mail.google.com/mail/u/0/#inbox/{thread_id}" if thread_id else None

            message = build_message(
                inbox_name=self.account_name,
                msg_id=raw["id"],
                subject=header("Subject", "No Subject"),
                sender=header("From", "Unknown Sender"),
                recipient=header("To", "Unknown Recipient"),
                received_date=header("Date", "Unknown Date"),
                body=_extract_body(raw["payload"]),
                url=url,
            )
            logger.debug(f"Retrieved email from {message.author}, subject: {message.title[:50]}...")
            return message
        except Exception as e:
            logger.error(f"Error getting email details for message {message_id}: {e}", exc_info=True)
            return None
