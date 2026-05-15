"""Thread-safe pub/sub for live events.

In local mode the web process runs the monitor in-background and learns about
events via this in-memory bus — no db polling needed, sub-millisecond fan-out
from supervisor to SSE subscribers.

In hosted mode the web process and the supervisor are separate processes and
can't share this bus; they fall back to polling `live_events` in sqlite.

Publishers (the monitor) are O(N subscribers) per event. Subscribers block
on a per-connection queue. Slow consumers drop events rather than blocking
the publisher — for a live feed we prefer fresh data over complete data,
and missed events are still in the durable `live_events` table if anything
needs to replay them.
"""

from __future__ import annotations

import queue
import threading
from typing import List, NamedTuple


class LiveEvent(NamedTuple):
    event_id: int
    event_type: str
    payload_json: str


class LiveEventBus:
    def __init__(self, queue_size: int = 256):
        self._queue_size = queue_size
        self._subscribers: List[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=self._queue_size)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def publish(self, event: LiveEvent) -> None:
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass
