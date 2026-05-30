"""The Item — the core object the classifier and notifier consume.

The email adapters (`sentinel.email`) map their provider-specific `EmailData`
to an `Item` at the boundary, so the pipeline never depends on email types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict


@dataclass
class Item:
    """One classifiable unit (an email), reshaped for the pipeline.

    Fields are chosen for what the classifier and notifier actually need:
    - `title` is the first-line summary (the email subject)
    - `body` is the full text the classifier reasons over
    - `author` is what fronts a notification ("who sent this")
    - `url` is the deep link if the source provides one
    - `metadata` carries extras the notifier may render
    """

    id: str
    title: str
    body: str
    author: str
    url: str | None
    received_at: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)
