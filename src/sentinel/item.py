"""The Item — the core object the classifier and notifier consume.

The email adapters (`sentinel.email`) build an `Item` from a fetched message at
the boundary (see `build_email_item`), so the pipeline never depends on email
internals.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict


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
