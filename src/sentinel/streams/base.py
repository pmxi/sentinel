"""The Item — the unit a stream produces and the pipeline consumes."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict


@dataclass
class Item:
    """A single unit produced by a stream.

    Fields are chosen for what the classifier and notifier actually need:
    - `title` is the first-line summary (the email subject)
    - `body` is the full text the classifier reasons over
    - `author` is what fronts a notification ("who sent this")
    - `url` is the deep link if the source provides one
    - `metadata` carries source-specific extras the notifier may render
    """

    id: str
    source_type: str
    title: str
    body: str
    author: str
    url: str | None
    received_at: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)
