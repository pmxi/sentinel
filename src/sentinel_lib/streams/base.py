"""Stream abstraction — transport-agnostic source of Items.

Every datastream (email, RSS, GitHub notifications, Slack mentions, Bluesky
firehose, ...) implements `Stream`. The async-generator contract hides whether
a stream is poll-based (RSS, IMAP) or push-based (WebSocket, SSE) — the
supervisor consumes both identically:

    async for item in stream.items():
        ...

The Item is what crosses the stream boundary. Source-specific types
(EmailMessage, RSSEntry) stay inside each stream's implementation.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator, Dict


@dataclass
class Item:
    """A single unit produced by a Stream.

    Fields are chosen for what the classifier and notifier actually need:
    - `title` is the first-line summary (subject, post title, headline)
    - `body` is the full text the classifier reasons over
    - `author` is what fronts a notification ("who/what sent this")
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


class Stream(ABC):
    """Base class for any datastream.

    Subclasses declare their `source_type` class attribute and implement
    `items()` as an async generator that yields Items indefinitely. Pull
    sources internally poll + sleep; push sources hold a connection and
    yield as events arrive. The supervisor doesn't care which.
    """

    source_type: str = ""

    def __init__(self, name: str):
        self.name = name

    @abstractmethod
    def items(self) -> AsyncIterator[Item]:
        """Yield Items as they become available. Runs indefinitely.

        Must be resilient — catch and log internal errors rather than
        letting them propagate. The supervisor treats a raised exception
        as "this stream is dead, restart it".
        """
        raise NotImplementedError
