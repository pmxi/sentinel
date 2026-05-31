"""The Item — the core object the classifier and notifier consume.

The email adapters (`sentinel.email`) build an `Item` from a fetched message at
the boundary (see `build_email_item` below), so the pipeline never depends on
email internals.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Optional

from sentinel.time_utils import ensure_utc, parse_iso_datetime, utc_now


@dataclass
class Item:
    """One classifiable unit (an email), reshaped for the pipeline.

    Fields are chosen for what the classifier and notifier actually need:
    - `stream_name` is the inbox this came from (logging + the event's column)
    - `title` is the first-line summary (the email subject)
    - `body` is the full text the classifier reasons over
    - `author` is what fronts a notification ("who sent this")
    - `url` is the deep link if the source provides one
    - `metadata` carries genuinely optional, source-specific extras
    """

    id: str
    stream_name: str
    title: str
    body: str
    author: str
    url: str | None
    received_at: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)


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
        stream_name=stream_name,
        title=subject or "(no subject)",
        body=rendered_body,
        author=sender or "unknown sender",
        url=url,
        received_at=_parse_received_date(received_date),
        metadata={
            "provider": provider,
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
