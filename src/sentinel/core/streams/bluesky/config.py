"""Configuration schema for Bluesky Jetstream streams."""

from __future__ import annotations

from pydantic import BaseModel


class BlueskyStreamConfig(BaseModel):
    """One Bluesky Jetstream subscription.

    Jetstream is the JSON-over-WebSocket fan-out of the at-proto firehose
    operated by the Bluesky team. We default to all `app.bsky.feed.post`
    creates network-wide — i.e. true firehose.
    """

    jetstream_url: str = "wss://jetstream2.us-east.bsky.network/subscribe"
    wanted_collections: list[str] = ["app.bsky.feed.post"]
    enabled: bool = True
    reconnect_max_seconds: int = 30
