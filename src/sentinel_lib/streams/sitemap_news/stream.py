"""Google News sitemap stream.

Polls a publisher's `<news:news>` sitemap and yields one Item per fresh
article URL. Belt-and-suspenders dedup: an in-memory `_seen` set for the
process lifetime plus the runtime's processed_items ledger across restarts.
First poll primes the seen set without emitting (otherwise every restart
would re-flood the dashboard with the last 48h backlog).

Supports gzipped sitemaps transparently (NYT, WaPo). Sitemap *index* files
(roots that list child sitemaps rather than article URLs) are detected and
logged with guidance — wire those by pointing at a leaf sitemap directly.
"""

from __future__ import annotations

import asyncio
import gzip
from datetime import UTC, datetime
from typing import AsyncIterator
from xml.etree import ElementTree as ET

import aiohttp

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item, Stream
from sentinel_lib.streams.sitemap_news.config import SitemapNewsStreamConfig
from sentinel_lib.time_utils import utc_now

logger = get_logger(__name__)

_NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
}


class SitemapNewsStream(Stream):
    source_type = "sitemap_news"

    def __init__(self, name: str, config: SitemapNewsStreamConfig):
        super().__init__(name=name)
        self.config = config
        self._seen: set[str] = set()
        self._first_poll = True

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"SitemapNewsStream {self.name!r} is disabled; not starting")
            return

        logger.info(
            f"[{self.name}] starting sitemap-news stream: {self.config.sitemap_url} "
            f"(poll every {self.config.poll_seconds}s)"
        )
        headers = {"User-Agent": self.config.user_agent}

        async with aiohttp.ClientSession(headers=headers) as session:
            while True:
                try:
                    entries = await self._fetch_entries(session)
                    for url, title, published, keywords in entries[: self.config.max_entries_per_poll]:
                        if url in self._seen:
                            continue
                        self._seen.add(url)
                        if self._first_poll:
                            continue
                        yield self._to_item(url, title, published, keywords)
                    self._first_poll = False
                except Exception as exc:
                    logger.warning(f"[{self.name}] sitemap poll failed: {exc}")
                await asyncio.sleep(self.config.poll_seconds)

    async def _fetch_entries(
        self, session: aiohttp.ClientSession
    ) -> list[tuple[str, str, datetime | None, list[str]]]:
        async with session.get(self.config.sitemap_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            resp.raise_for_status()
            raw = await resp.read()

        # aiohttp auto-decompresses gzipped HTTP responses, so don't trust
        # the URL suffix — only decompress when the bytes still carry the
        # gzip magic header.
        if _looks_gzipped(raw):
            raw = gzip.decompress(raw)

        try:
            root = ET.fromstring(raw)
        except ET.ParseError as exc:
            raise RuntimeError(f"invalid XML: {exc}") from exc

        tag = _local_name(root.tag)
        if tag == "sitemapindex":
            child = next(iter(root.findall("sm:sitemap/sm:loc", _NS)), None)
            child_url = child.text.strip() if child is not None and child.text else "(none)"
            raise RuntimeError(
                f"sitemap is an index, not a leaf — point at a child URL "
                f"(e.g. {child_url})"
            )
        if tag != "urlset":
            raise RuntimeError(f"unexpected root element: {tag!r}")

        out: list[tuple[str, str, datetime | None, list[str]]] = []
        for url_el in root.findall("sm:url", _NS):
            loc_el = url_el.find("sm:loc", _NS)
            if loc_el is None or not loc_el.text:
                continue
            url = loc_el.text.strip()

            news_el = url_el.find("news:news", _NS)
            title = ""
            published: datetime | None = None
            keywords: list[str] = []
            if news_el is not None:
                t = news_el.find("news:title", _NS)
                if t is not None and t.text:
                    title = t.text.strip()
                pd = news_el.find("news:publication_date", _NS)
                if pd is not None and pd.text:
                    published = _parse_iso(pd.text.strip())
                kw = news_el.find("news:keywords", _NS)
                if kw is not None and kw.text:
                    keywords = [k.strip() for k in kw.text.split(",") if k.strip()]

            if not title:
                # Some publishers omit news:title; fall back to last URL segment.
                title = url.rsplit("/", 1)[-1].replace("-", " ").strip() or "(no title)"
            out.append((url, title, published, keywords))
        return out

    def _to_item(
        self,
        url: str,
        title: str,
        published: datetime | None,
        keywords: list[str],
    ) -> Item:
        publication = self.config.publication_name or self.name
        body = (
            f"Publication: {publication}\n"
            f"Title: {title}\n"
            f"Published: {published.isoformat() if published else 'unknown'}\n"
            f"URL: {url}\n"
            + (f"Keywords: {', '.join(keywords)}\n" if keywords else "")
        )
        return Item(
            id=url,
            source_type="sitemap_news",
            title=title,
            body=body,
            author=publication,
            url=url,
            received_at=published or utc_now(),
            metadata={
                "stream_name": self.name,
                "publication": publication,
                "keywords": keywords,
            },
        )


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _looks_gzipped(raw: bytes) -> bool:
    return len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None
