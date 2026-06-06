"""The Message — the core object the classifier and notifier consume.

The email adapters (`sentinel.email`) build a `Message` from a fetched email at
the boundary (see `build_message` below), so the pipeline never depends on
email internals.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Optional

from sentinel.time_utils import ensure_utc, parse_iso_datetime, utc_now


@dataclass
class Message:
    """One classifiable message (an email), reshaped for the pipeline.

    Fields are chosen for what the classifier and notifier actually need:
    - `inbox_name` is the inbox this came from (logging + the message's column)
    - `title` is the first-line summary (the email subject)
    - `body` is the full text the classifier reasons over
    - `author` is what fronts a notification ("who sent this")
    - `url` is the deep link if the source provides one
    """

    id: str
    inbox_name: str
    title: str
    body: str
    author: str
    url: str | None
    received_at: datetime


def build_message(
    *,
    inbox_name: str,
    msg_id: str,
    subject: str,
    sender: str,
    recipient: str,
    received_date: str,
    body: str,
    url: Optional[str] = None,
) -> Message:
    """Build the pipeline's Message from one email's extracted fields.

    The single email->Message boundary: renders the body the classifier reads,
    parses the date, and namespaces the id by inbox so message ids from
    different inboxes can't collide in the globally-unique dedup ledger.

    This is the one place placeholder fallbacks for missing headers live, so the
    clients can pass raw header values (or "") without each repeating them.
    """
    subject = subject or "(no subject)"
    sender = sender or "unknown sender"
    recipient = recipient or "unknown recipient"
    rendered_body = (
        f"From: {sender}\n"
        f"To: {recipient}\n"
        f"Subject: {subject}\n"
        f"Date: {received_date}\n\n"
        f"{body}"
    )
    return Message(
        id=f"{inbox_name}:{msg_id}",
        inbox_name=inbox_name,
        title=subject,
        body=rendered_body,
        author=sender,
        url=url,
        received_at=_parse_received_date(received_date),
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
