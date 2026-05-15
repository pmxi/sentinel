"""Configuration schema for RSS/Atom streams."""

from __future__ import annotations

from pydantic import BaseModel, HttpUrl


class RSSStreamConfig(BaseModel):
    """One RSS/Atom feed subscription."""

    feed_url: HttpUrl
    poll_seconds: int = 300          # default 5 minutes
    enabled: bool = True
    max_entries_per_poll: int = 50   # cap to avoid flooding on first poll

    class Config:
        use_enum_values = True
