import email
import imaplib
from datetime import datetime
from email.header import decode_header
from email.message import Message
from typing import List, Optional

from sentinel.item import Item, build_email_item
from sentinel.logging_config import get_logger
from sentinel.email.mail_config import AuthMethod, MailAccountConfig

logger = get_logger(__name__)

# Bound each IMAP connection so a stalled mail server can't hang a poll
# forever. Set explicitly per-connection — never via socket.setdefaulttimeout,
# which would leak onto every other socket in the process.
_CONNECT_TIMEOUT_S = 30


class IMAPClient:
    """Generic IMAP email client that supports multiple authentication methods"""

    def __init__(self, account_name: str, config: MailAccountConfig):
        self.account_name = account_name
        self.config = config
        self.connection = None

        # Validate IMAP configuration
        if not self.config.server:
            raise ValueError(f"IMAP server not specified for account {account_name}")

    def _get_connection(self) -> imaplib.IMAP4_SSL:
        """Get or create IMAP connection"""
        if self.connection is None:
            server = self.config.server
            port = self.config.port
            if server is None or port is None:
                raise ValueError("IMAP server and port must be set")
            logger.info(f"Connecting to {server}:{port}")
            self.connection = imaplib.IMAP4_SSL(server, port, timeout=_CONNECT_TIMEOUT_S)
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
        if self.connection is None:
            raise RuntimeError("Cannot authenticate before connecting")
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

    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[Item]:
        """Get emails received after a specific timestamp.

        Searches and fetches by UID, not message sequence number: UIDs are
        stable for the life of the mailbox, so they're safe to use as the
        dedup identity, whereas sequence numbers shift as mail is expunged.
        """
        try:
            conn = self._get_connection()

            # IMAP SINCE has day granularity, so we still filter precisely below.
            date_str = after_timestamp.strftime("%d-%b-%Y")

            # Build search criteria
            if unread_only:
                search_criteria = f'(UNSEEN SINCE "{date_str}")'
            else:
                search_criteria = f'(SINCE "{date_str}")'

            status, messages = conn.uid("SEARCH", None, search_criteria)  # ty: ignore[invalid-argument-type]
            if status != "OK" or not messages or not messages[0]:
                return []

            uids = messages[0].split()
            items: List[Item] = []

            for uid in uids:
                item = self._fetch_email(uid.decode())
                if item is None:
                    continue
                # IMAP SINCE is day-granular, so filter precisely here.
                if item.received_at > after_timestamp:
                    items.append(item)

            return items
        except Exception as e:
            logger.error(f"Error getting emails after timestamp: {e}")
            raise

    def _fetch_email(self, uid: str) -> Optional[Item]:
        """Fetch and parse a single email by UID into an Item."""
        try:
            conn = self._get_connection()

            # https://datatracker.ietf.org/doc/html/rfc3501.html
            # the above RFC is obsoleted by the below RFC.
            # https://datatracker.ietf.org/doc/html/rfc9051
            # From my investigation, it seems that iCloud IMAP server supports the updated IMAP protocol in RFC 9051.
            # In this protocol, the FETCH command doesn't support using RFC822 to get the full email content.
            # However we can use BODY[]
            status, data = conn.uid("FETCH", uid, "BODY[]")
            if status != "OK" or not data or not data[0]:
                return None

            # Parse email content - data[0] is a tuple of (header, raw_email)
            raw_email = data[0][1]
            if not isinstance(raw_email, bytes):
                return None

            msg = email.message_from_bytes(raw_email)

            # Extract headers
            subject = self._decode_header(msg["Subject"] or "No Subject")
            sender = self._decode_header(msg["From"] or "Unknown Sender")
            recipient = self._decode_header(msg["To"] or "Unknown Recipient")
            date = msg["Date"] or "Unknown Date"

            # Extract body
            body = self._extract_body(msg)

            return build_email_item(
                stream_name=self.account_name,
                provider=self.config.provider,
                msg_id=uid,
                subject=subject,
                sender=sender,
                recipient=recipient,
                received_date=date,
                body=body,
            )
        except Exception as e:
            logger.error(f"Error fetching email uid={uid}: {e}")
            return None

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
