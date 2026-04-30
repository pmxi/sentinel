"""Bluesky Jetstream stream.

Holds a WebSocket connection to a public Jetstream relay and yields one
Item per matching commit. Items are tagged `skip_classification` so the
local processor bypasses the LLM and the processed_items ledger; at
firehose volume (hundreds/sec) classifying every post would be both
prohibitively expensive and pointless — there's no per-item dedup value
when the entire feed is one-shot.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import AsyncIterator
from urllib.parse import urlencode

import aiohttp

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item, Stream
from sentinel_lib.streams.bluesky.config import BlueskyStreamConfig
from sentinel_lib.time_utils import utc_now

logger = get_logger(__name__)


class BlueskyStream(Stream):
    source_type = "bluesky"

    def __init__(self, name: str, config: BlueskyStreamConfig):
        super().__init__(name=name)
        self.config = config

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"BlueskyStream {self.name!r} is disabled; not starting")
            return

        url = self._build_url()
        logger.info(f"[{self.name}] starting Bluesky Jetstream: {url}")

        backoff = 1.0
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(url, heartbeat=30) as ws:
                        backoff = 1.0
                        logger.info(f"[{self.name}] connected to Jetstream")
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                item = self._parse(msg.data)
                                if item is not None:
                                    yield item
                            elif msg.type in (
                                aiohttp.WSMsgType.CLOSED,
                                aiohttp.WSMsgType.CLOSING,
                                aiohttp.WSMsgType.ERROR,
                            ):
                                break
            except Exception as exc:
                logger.warning(f"[{self.name}] Jetstream disconnected: {exc}")

            sleep_for = min(backoff, float(self.config.reconnect_max_seconds))
            logger.info(f"[{self.name}] reconnecting in {sleep_for:.1f}s")
            await asyncio.sleep(sleep_for)
            backoff *= 2

    def _build_url(self) -> str:
        params = [("wantedCollections", c) for c in self.config.wanted_collections]
        if not params:
            return self.config.jetstream_url
        return f"{self.config.jetstream_url}?{urlencode(params)}"

    def _parse(self, data: str) -> Item | None:
        try:
            evt = json.loads(data)
        except Exception:
            return None
        if evt.get("kind") != "commit":
            return None
        commit = evt.get("commit") or {}
        if commit.get("operation") != "create":
            return None
        if commit.get("collection") != "app.bsky.feed.post":
            return None
        record = commit.get("record") or {}
        text = (record.get("text") or "").strip()
        did = evt.get("did") or ""
        rkey = commit.get("rkey") or ""
        if not did or not rkey:
            return None

        # Bluesky posts cap at 300 chars natively, so use the whole post as
        # the title — truncating cosmetically loses signal that downstream
        # labeling and classification need.
        title = text or "(empty post)"

        received = _parse_created_at(record.get("createdAt"))

        return Item(
            id=f"at://{did}/app.bsky.feed.post/{rkey}",
            source_type="bluesky",
            title=title,
            body=text,
            author=did,
            url=f"https://bsky.app/profile/{did}/post/{rkey}",
            received_at=received,
            metadata={
                "stream_name": self.name,
                "skip_classification": True,
                "lang": (record.get("langs") or [None])[0],
            },
        )


def _parse_created_at(value: object) -> datetime:
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            pass
    return utc_now()
