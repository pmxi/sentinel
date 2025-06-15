import email
import imaplib
from datetime import datetime
from email.header import decode_header
from email.message import Message
from typing import List, Optional

from ..logging_config import get_logger
from .email_client_base import EmailClient
from .gmail.models import EmailData
from .mail_config import AuthMethod, MailAccountConfig

logger = get_logger(__name__)


class IMAPClient(EmailClient):
    """Generic IMAP email client that supports multiple authentication methods"""

    def __init__(self, account_name: str, config: MailAccountConfig):
        # Initialize base with account_name and its MailAccountConfig
        super().__init__(account_name, config)
        self.config = config
        self.connection = None

        # Validate IMAP configuration
        if not self.config.server:
            raise ValueError(f"IMAP server not specified for account {account_name}")

    def _get_connection(self) -> imaplib.IMAP4_SSL:
        """Get or create IMAP connection"""
        if self.connection is None:
            logger.info(f"Connecting to {self.config.server}:{self.config.port}")
            self.connection = imaplib.IMAP4_SSL(self.config.server, self.config.port)
            self._authenticate()

            # Select the first configured folder (default INBOX)
            folder = (
                self.config.settings.folders[0]
                if self.config.settings.folders
                else "INBOX"
            )
            self.connection.select(folder)
        return self.connection

    def _authenticate(self):
        """Authenticate based on configured method"""
        if self.config.auth.method == AuthMethod.PASSWORD:
            if not self.config.auth.username or not self.config.auth.password:
                raise ValueError("Username and password required for password auth")
            logger.info(f"Authenticating with password for {self.config.auth.username}")
            self.connection.login(self.config.auth.username, self.config.auth.password)

        elif self.config.auth.method == AuthMethod.OAUTH2:
            raise NotImplementedError(
                f"OAuth2 not yet implemented for {self.config.server}"
            )
        else:
            raise ValueError(f"Unsupported auth method: {self.config.auth.method}")

    def close(self):
        """Close the IMAP connection"""
        logger.info(f"Closing connection to {self.config.provider}")
        if self.connection:
            try:
                self.connection.close()
                self.connection.logout()
            except (imaplib.IMAP4.error, AttributeError, OSError) as e:
                # It's ok if closing fails - we're cleaning up anyway
                logger.debug(f"Error during connection cleanup: {e}")
                pass
            self.connection = None

    def get_unread_emails(self) -> List[EmailData]:
        """Fetch unread emails from inbox"""
        try:
            conn = self._get_connection()

            # Search for unread emails
            status, messages = conn.search(None, "UNSEEN")
            if status != "OK" or not messages or not messages[0]:
                return []

            email_ids = messages[0].split()
            emails: List[EmailData] = []

            for email_id in email_ids:
                email_data = self._fetch_email(email_id.decode())
                if email_data:
                    emails.append(email_data)

            return emails
        except Exception as e:
            logger.error(f"Failed to fetch unread emails: {e}")
            raise

    def get_latest_email(self) -> Optional[EmailData]:
        """Get the most recent email from the inbox"""
        try:
            conn = self._get_connection()

            # Search for all emails
            status, messages = conn.search(None, "ALL")
            if status != "OK" or not messages or not messages[0]:
                return None

            email_ids = messages[0].split()
            if not email_ids:
                return None

            # Get the latest email (last ID)
            latest_id = email_ids[-1].decode()
            return self._fetch_email(latest_id)
        except Exception as e:
            logger.error(f"Error getting latest email: {e}")
            return None

    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[EmailData]:
        """Get emails received after a specific timestamp"""
        try:
            conn = self._get_connection()

            # Format date for IMAP search
            date_str = after_timestamp.strftime("%d-%b-%Y")

            # Build search criteria
            if unread_only:
                search_criteria = f'(UNSEEN SINCE "{date_str}")'
            else:
                search_criteria = f'(SINCE "{date_str}")'

            status, messages = conn.search(None, search_criteria)
            if status != "OK" or not messages or not messages[0]:
                return []

            email_ids = messages[0].split()
            emails: List[EmailData] = []

            for email_id in email_ids:
                email_data = self._fetch_email(email_id.decode())
                if (
                    email_data
                    and self._parse_date(email_data.received_date) > after_timestamp
                ):
                    emails.append(email_data)

            return emails
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}")
            return []

    def _fetch_email(self, email_id: str) -> Optional[EmailData]:
        """Fetch and parse a single email"""
        try:
            conn = self._get_connection()

            # https://datatracker.ietf.org/doc/html/rfc3501.html
            # the above RFC is obsoleted by the below RFC.
            # https://datatracker.ietf.org/doc/html/rfc9051
            # From my investigation, it seems that iCloud IMAP server supports the updated IMAP protocol in RFC 9051.
            # In this protocol, the FETCH command doesn't support using RFC822 to get the full email content.
            # However we can use BODY[]
            status, data = conn.fetch(email_id, "(FLAGS BODY[])")
            if status != "OK" or not data or not data[0]:
                return None

            # Parse email content - data[0] is a tuple of (flags, raw_email)
            raw_email = data[0][1]
            if not isinstance(raw_email, bytes):
                return None

            msg = email.message_from_bytes(raw_email)

            # Check if read - data[0][0] contains the flags
            flags_data = data[0][0]
            if isinstance(flags_data, bytes):
                flags = flags_data.decode()
            else:
                flags = str(flags_data) if flags_data else ""
            is_read = "\\Seen" in flags

            # Extract headers
            subject = self._decode_header(msg["Subject"] or "No Subject")
            sender = self._decode_header(msg["From"] or "Unknown Sender")
            recipient = self._decode_header(msg["To"] or "Unknown Recipient")
            date = msg["Date"] or "Unknown Date"

            # Extract body
            body = self._extract_body(msg)

            return EmailData(
                id=email_id,
                subject=subject,
                sender=sender,
                recipient=recipient,
                body=body,
                received_date=date,
                is_read=is_read,
                provider=self.provider_type,
            )
        except Exception as e:
            logger.error(f"Error fetching email {email_id}: {e}")
            return None

    def mark_as_read(self, message_id: str):
        """Mark email as read"""
        try:
            conn = self._get_connection()
            conn.store(message_id, "+FLAGS", "\\Seen")
            logger.info(f"Marked email {message_id} as read")
        except Exception as e:
            logger.error(f"Failed to mark as read: {e}")
            raise

    def move_to_junk(self, message_id: str):
        """Move email to junk folder"""
        try:
            conn = self._get_connection()

            # Mark as seen
            conn.store(message_id, "+FLAGS", "\\Seen")

            # Use configured junk folder name
            junk_folder_name = self.config.settings.junk_folder_name
            
            try:
                # Copy to junk folder
                result = conn.copy(message_id, junk_folder_name)
                if result[0] == "OK":
                    # Mark for deletion from inbox
                    conn.store(message_id, "+FLAGS", "\\Deleted")
                    conn.expunge()
                    logger.info(f"Moved email {message_id} to {junk_folder_name}")
                else:
                    raise Exception(f"Failed to copy message to {junk_folder_name}")
            except (imaplib.IMAP4.error, ValueError) as e:
                logger.error(f"Failed to move to folder {junk_folder_name}: {e}")
                raise Exception(f"Could not move email to junk folder '{junk_folder_name}': {e}")

        except Exception as e:
            logger.error(f"Failed to move email to junk: {e}")
            raise

    def _decode_header(self, header: str) -> str:
        """Decode email header"""
        if not header:
            return ""

        decoded_parts: List[str] = []
        for part, encoding in decode_header(header):
            if isinstance(part, bytes):
                try:
                    decoded_parts.append(
                        part.decode(encoding or "utf-8", errors="ignore")
                    )
                except (UnicodeDecodeError, LookupError):
                    decoded_parts.append(part.decode("utf-8", errors="ignore"))
            else:
                decoded_parts.append(str(part))
        return " ".join(decoded_parts)

    def _extract_body(self, msg: Message) -> str:
        """Extract email body"""
        body = ""

        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    payload = part.get_payload(decode=True)
                    if payload and isinstance(payload, bytes):
                        try:
                            body = payload.decode("utf-8", errors="ignore")
                            break
                        except (UnicodeDecodeError, AttributeError):
                            continue
        else:
            payload = msg.get_payload(decode=True)
            if payload and isinstance(payload, bytes):
                try:
                    body = payload.decode("utf-8", errors="ignore")
                except (UnicodeDecodeError, AttributeError):
                    # Fallback to string representation
                    body = str(payload)

        return body

    def _parse_date(self, date_str: str) -> datetime:
        """Parse email date string to datetime"""
        try:
            # Remove timezone info for simpler parsing
            date_str = date_str.split(" (")[0]
            return datetime.strptime(date_str, "%a, %d %b %Y %H:%M:%S %z").replace(
                tzinfo=None
            )
        except (ValueError, AttributeError) as e:
            logger.warning(f"Failed to parse email date '{date_str}': {e}. Using current time.")
            return datetime.now()
