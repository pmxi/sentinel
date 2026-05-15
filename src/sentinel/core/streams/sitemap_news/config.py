"""Configuration schema for Google News sitemap streams."""

from __future__ import annotations

from pydantic import BaseModel


class SitemapNewsStreamConfig(BaseModel):
    """Polls a publisher's Google News sitemap on a fixed interval.

    News orgs maintain a `<news:news>` sitemap (declared in robots.txt and
    required by Google News) listing every article published in the last
    ~48h with publish timestamps. Polling it every minute or two gives a
    near-real-time wire of headlines + URLs without scraping article HTML.
    """

    sitemap_url: str
    publication_name: str = ""
    poll_seconds: int = 120
    enabled: bool = True
    max_entries_per_poll: int = 200
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    )
