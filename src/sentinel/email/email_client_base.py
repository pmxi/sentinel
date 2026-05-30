from abc import ABC, abstractmethod
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import List, Optional

from sentinel.item import Item
from sentinel.email.mail_config import MailAccountConfig
from sentinel.time_utils import ensure_utc, parse_iso_datetime, utc_now


class EmailClient(ABC):
    """Abstract base class for email clients."""

    def __init__(self, account_name: str, config: MailAccountConfig):
        self.account_name = account_name
        self.config = config

    @abstractmethod
    def get_emails_after_timestamp(
        self, after_timestamp: datetime, unread_only: bool = True
    ) -> List[Item]:
        """Get items for emails received after a specific timestamp."""
        pass

    def close(self) -> None:
        """Release any underlying resources held by the client."""
        return None


def build_email_item(
    *,
    stream_name: str,
    provider: str,
    msg_id: str,
    subject: str,
    sender: str,
    recipient: str,
    received_date: str,
    body: str,
    url: Optional[str] = None,
) -> Item:
    """Build the pipeline's Item from one email's extracted fields.

    The single email->Item boundary: renders the body the classifier reads,
    parses the date, and namespaces the id by stream so message ids from
    different inboxes can't collide in the globally-unique dedup ledger.
    """
    rendered_body = (
        f"From: {sender}\n"
        f"To: {recipient}\n"
        f"Subject: {subject}\n"
        f"Date: {received_date}\n\n"
        f"{body}"
    )
    return Item(
        id=f"{stream_name}:{msg_id}",
        title=subject or "(no subject)",
        body=rendered_body,
        author=sender or "unknown sender",
        url=url,
        received_at=_parse_received_date(received_date),
        metadata={
            "provider": provider,
            "stream_name": stream_name,
            "recipient": recipient,
        },
    )


def _parse_received_date(date_str: str) -> datetime:
    if not date_str:
        return utc_now()
    try:
        return ensure_utc(parsedate_to_datetime(date_str))
    except (TypeError, ValueError):
        try:
            return parse_iso_datetime(date_str)
        except ValueError:
            return utc_now()
