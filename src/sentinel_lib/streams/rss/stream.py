"""RSS/Atom stream.

Polls the configured feed URL, maps each new entry to an Item, and yields.
Dedup is belt-and-suspenders: an in-memory `_seen` set for this process's
run, plus the shared processed_items ledger for across-restart persistence.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any, AsyncIterator

import feedparser  # type: ignore

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item, Stream
from sentinel_lib.streams.rss.config import RSSStreamConfig
from sentinel_lib.time_utils import utc_now

logger = get_logger(__name__)


class RSSStream(Stream):
    source_type = "rss"

    def __init__(
        self,
        name: str,
        config: RSSStreamConfig,
    ):
        super().__init__(name=name)
        self.config = config
        self._seen: set[str] = set()
        self._first_poll = True

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"RSSStream {self.name!r} is disabled; not starting")
            return

        feed_url = str(self.config.feed_url)
        logger.info(
            f"[{self.name}] starting RSS stream: {feed_url} "
            f"(poll every {self.config.poll_seconds}s)"
        )

        while True:
            try:
                parsed = await asyncio.to_thread(feedparser.parse, feed_url)
                entries = getattr(parsed, "entries", []) or []
                logger.debug(
                    f"[{self.name}] fetched {len(entries)} entries from {feed_url}"
                )
                for entry in entries[: self.config.max_entries_per_poll]:
                    item = self._entry_to_item(entry, parsed.feed)
                    if item is None:
                        continue
                    if item.id in self._seen:
                        continue
                    self._seen.add(item.id)
                    # On the very first poll after startup, prime the seen
                    # set but don't emit — otherwise every restart would
                    # re-flood the classifier with backlog.
                    if self._first_poll:
                        continue
                    yield item
                self._first_poll = False
            except Exception as e:
                logger.exception(f"[{self.name}] RSS poll failed: {e}")

            await asyncio.sleep(self.config.poll_seconds)

    def _entry_to_item(self, entry: Any, feed_meta: Any) -> Item | None:
        entry_id = (
            getattr(entry, "id", None)
            or getattr(entry, "guid", None)
            or getattr(entry, "link", None)
        )
        if not entry_id:
            return None

        title = getattr(entry, "title", "") or "(no title)"
        url = getattr(entry, "link", None)
        published = _entry_published(entry)

        summary = getattr(entry, "summary", "") or ""
        content_list = getattr(entry, "content", None) or []
        full_content = summary
        if content_list:
            full_content = "\n\n".join(
                c.get("value", "") for c in content_list if isinstance(c, dict)
            ) or summary

        feed_title = getattr(feed_meta, "title", "") or "RSS feed"
        author = (
            getattr(entry, "author", None)
            or feed_title
        )

        body = (
            f"Feed: {feed_title}\n"
            f"Title: {title}\n"
            f"Author: {author}\n"
            f"Published: {published.isoformat() if published else 'unknown'}\n"
            f"URL: {url or 'N/A'}\n\n"
            f"{full_content}"
        )

        return Item(
            id=str(entry_id),
            source_type="rss",
            title=title,
            body=body,
            author=author,
            url=url,
            received_at=published or utc_now(),
            metadata={
                "feed_title": feed_title,
                "feed_url": str(self.config.feed_url),
                "stream_name": self.name,
            },
        )


def _entry_published(entry: Any) -> datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        value = getattr(entry, attr, None)
        if value:
            try:
                return datetime(*value[:6], tzinfo=UTC)
            except (TypeError, ValueError):
                continue
    return None
